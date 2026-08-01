ALTER TABLE public.billing_accounts
  ADD COLUMN stripe_customer_id text,
  ADD COLUMN stripe_livemode boolean,
  ADD COLUMN stripe_observation_generation bigint NOT NULL DEFAULT 0
    CHECK (stripe_observation_generation >= 0),
  ADD COLUMN stripe_reconcile_generation bigint NOT NULL DEFAULT 0
    CHECK (stripe_reconcile_generation >= 0),
  ADD COLUMN stripe_reconciled_at timestamptz,
  ADD CONSTRAINT billing_accounts_stripe_binding_pair_v16 CHECK (
    (stripe_customer_id IS NULL) = (stripe_livemode IS NULL)
  ),
  ADD CONSTRAINT billing_accounts_stripe_customer_format_v16 CHECK (
    stripe_customer_id IS NULL OR (
      octet_length(stripe_customer_id) BETWEEN 5 AND 255
      AND stripe_customer_id ~ '^cus_[A-Za-z0-9_]+$'
    )
  ),
  ADD CONSTRAINT billing_accounts_stripe_reconcile_clock_v16 CHECK (
    (stripe_reconcile_generation = 0) = (stripe_reconciled_at IS NULL)
  ),
  ADD CONSTRAINT billing_accounts_stripe_binding_unique_v16
    UNIQUE (tenant_id, stripe_customer_id, stripe_livemode);

CREATE UNIQUE INDEX billing_accounts_stripe_customer_unique_v16
  ON public.billing_accounts (stripe_livemode, stripe_customer_id)
  WHERE stripe_customer_id IS NOT NULL;

CREATE FUNCTION public.guard_billing_account_stripe_state_v16()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF OLD.stripe_customer_id IS NOT NULL AND (
    OLD.stripe_customer_id IS DISTINCT FROM NEW.stripe_customer_id
    OR OLD.stripe_livemode IS DISTINCT FROM NEW.stripe_livemode
  ) THEN
    RAISE EXCEPTION 'A Stripe customer binding is immutable.' USING ERRCODE = '23514';
  END IF;

  IF NEW.stripe_reconcile_generation < OLD.stripe_reconcile_generation
    OR NEW.stripe_reconcile_generation > OLD.stripe_reconcile_generation + 1 THEN
    RAISE EXCEPTION 'A Stripe reconciliation generation must advance exactly once.' USING ERRCODE = '23514';
  END IF;

  IF NEW.stripe_observation_generation < OLD.stripe_observation_generation
    OR NEW.stripe_observation_generation > OLD.stripe_observation_generation + 1 THEN
    RAISE EXCEPTION 'A Stripe observation generation must advance exactly once.' USING ERRCODE = '23514';
  END IF;

  IF NEW.stripe_reconcile_generation = OLD.stripe_reconcile_generation
    AND NEW.stripe_reconciled_at IS DISTINCT FROM OLD.stripe_reconciled_at THEN
    RAISE EXCEPTION 'A Stripe reconciliation timestamp requires a newer generation.' USING ERRCODE = '23514';
  END IF;

  IF NEW.stripe_reconcile_generation > OLD.stripe_reconcile_generation
    AND NEW.stripe_customer_id IS NULL THEN
    RAISE EXCEPTION 'Stripe reconciliation requires a customer binding.' USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$function$;

CREATE TRIGGER billing_accounts_guard_stripe_state_v16
BEFORE UPDATE ON public.billing_accounts
FOR EACH ROW
EXECUTE FUNCTION public.guard_billing_account_stripe_state_v16();

CREATE TABLE public.billing_checkout_attempts (
  tenant_id text NOT NULL,
  attempt_id uuid NOT NULL,
  plan_key text NOT NULL CHECK (
    plan_key = btrim(plan_key)
    AND octet_length(plan_key) BETWEEN 1 AND 64
    AND plan_key ~ '^[a-z][a-z0-9_-]*$'
  ),
  stripe_price_id text NOT NULL CHECK (
    octet_length(stripe_price_id) BETWEEN 7 AND 255
    AND stripe_price_id ~ '^price_[A-Za-z0-9_]+$'
  ),
  stripe_customer_id text CHECK (
    stripe_customer_id IS NULL OR (
      octet_length(stripe_customer_id) BETWEEN 5 AND 255
      AND stripe_customer_id ~ '^cus_[A-Za-z0-9_]+$'
    )
  ),
  stripe_checkout_session_id text CHECK (
    stripe_checkout_session_id IS NULL OR (
      octet_length(stripe_checkout_session_id) BETWEEN 4 AND 255
      AND stripe_checkout_session_id ~ '^cs_[A-Za-z0-9_]+$'
    )
  ),
  stripe_livemode boolean NOT NULL,
  state text NOT NULL DEFAULT 'reserved' CHECK (state IN ('reserved', 'open', 'consumed', 'failed', 'expired')),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, attempt_id),
  UNIQUE (attempt_id),
  UNIQUE (stripe_checkout_session_id),
  FOREIGN KEY (tenant_id) REFERENCES public.billing_accounts (tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, stripe_customer_id, stripe_livemode)
    REFERENCES public.billing_accounts (tenant_id, stripe_customer_id, stripe_livemode)
    ON DELETE RESTRICT,
  CHECK (expires_at > created_at AND expires_at <= created_at + interval '25 hours'),
  CHECK (
    (state = 'reserved' AND stripe_checkout_session_id IS NULL)
    OR (state = 'open' AND stripe_checkout_session_id IS NOT NULL)
    OR (state = 'failed' AND stripe_checkout_session_id IS NULL)
    OR state IN ('consumed', 'expired')
  )
);

CREATE UNIQUE INDEX billing_checkout_attempts_active_tenant_v16
  ON public.billing_checkout_attempts (tenant_id)
  WHERE state IN ('reserved', 'open');

CREATE INDEX billing_checkout_attempts_expiry_v16
  ON public.billing_checkout_attempts (expires_at, tenant_id, attempt_id);

CREATE TABLE public.stripe_event_inbox (
  stripe_event_id text NOT NULL CHECK (
    octet_length(stripe_event_id) BETWEEN 5 AND 255
    AND stripe_event_id ~ '^evt_[A-Za-z0-9_]+$'
  ),
  tenant_id text NOT NULL,
  checkout_attempt_id uuid,
  stripe_customer_id text NOT NULL CHECK (
    octet_length(stripe_customer_id) BETWEEN 5 AND 255
    AND stripe_customer_id ~ '^cus_[A-Za-z0-9_]+$'
  ),
  stripe_subscription_id text NOT NULL CHECK (
    octet_length(stripe_subscription_id) BETWEEN 5 AND 255
    AND stripe_subscription_id ~ '^sub_[A-Za-z0-9_]+$'
  ),
  stripe_livemode boolean NOT NULL,
  event_type text NOT NULL CHECK (
    event_type = btrim(event_type)
    AND octet_length(event_type) BETWEEN 1 AND 128
    AND event_type ~ '^[a-z][a-z0-9_.]*$'
  ),
  source_object_id text CHECK (
    source_object_id IS NULL OR (
      octet_length(source_object_id) BETWEEN 3 AND 255
      AND source_object_id ~ '^[A-Za-z][A-Za-z0-9_]+$'
    )
  ),
  event_created_at timestamptz NOT NULL,
  payload_digest bytea NOT NULL CHECK (octet_length(payload_digest) = 32),
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'processed')),
  received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  processed_at timestamptz,
  PRIMARY KEY (stripe_livemode, stripe_event_id),
  UNIQUE (tenant_id, stripe_customer_id, stripe_livemode, stripe_event_id),
  FOREIGN KEY (tenant_id) REFERENCES public.billing_accounts (tenant_id)
    ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, checkout_attempt_id)
    REFERENCES public.billing_checkout_attempts (tenant_id, attempt_id)
    ON DELETE RESTRICT,
  CHECK ((state = 'pending') = (processed_at IS NULL)),
  CHECK (processed_at IS NULL OR processed_at >= received_at)
);

CREATE INDEX stripe_event_inbox_pending_v16
  ON public.stripe_event_inbox (received_at, stripe_event_id)
  WHERE state = 'pending';

CREATE FUNCTION public.guard_stripe_event_inbox_v16()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Stripe event inbox entries cannot be deleted.' USING ERRCODE = '23514';
  END IF;

  IF OLD.stripe_event_id IS DISTINCT FROM NEW.stripe_event_id
    OR OLD.tenant_id IS DISTINCT FROM NEW.tenant_id
    OR OLD.checkout_attempt_id IS DISTINCT FROM NEW.checkout_attempt_id
    OR OLD.stripe_customer_id IS DISTINCT FROM NEW.stripe_customer_id
    OR OLD.stripe_subscription_id IS DISTINCT FROM NEW.stripe_subscription_id
    OR OLD.stripe_livemode IS DISTINCT FROM NEW.stripe_livemode
    OR OLD.event_type IS DISTINCT FROM NEW.event_type
    OR OLD.source_object_id IS DISTINCT FROM NEW.source_object_id
    OR OLD.event_created_at IS DISTINCT FROM NEW.event_created_at
    OR OLD.payload_digest IS DISTINCT FROM NEW.payload_digest
    OR OLD.received_at IS DISTINCT FROM NEW.received_at THEN
    RAISE EXCEPTION 'A Stripe event inbox identity and payload are immutable.' USING ERRCODE = '23514';
  END IF;

  IF OLD.state <> 'pending' OR NEW.state <> 'processed' THEN
    RAISE EXCEPTION 'A Stripe event inbox entry can only be processed once.' USING ERRCODE = '23514';
  END IF;

  NEW.processed_at := clock_timestamp();
  RETURN NEW;
END;
$function$;

CREATE TRIGGER stripe_event_inbox_guard_mutation_v16
BEFORE UPDATE OR DELETE ON public.stripe_event_inbox
FOR EACH ROW
EXECUTE FUNCTION public.guard_stripe_event_inbox_v16();

CREATE TABLE public.billing_subscriptions (
  tenant_id text NOT NULL,
  stripe_subscription_id text NOT NULL CHECK (
    octet_length(stripe_subscription_id) BETWEEN 5 AND 255
    AND stripe_subscription_id ~ '^sub_[A-Za-z0-9_]+$'
  ),
  stripe_customer_id text NOT NULL CHECK (
    octet_length(stripe_customer_id) BETWEEN 5 AND 255
    AND stripe_customer_id ~ '^cus_[A-Za-z0-9_]+$'
  ),
  stripe_livemode boolean NOT NULL,
  status text NOT NULL CHECK (
    status IN ('incomplete', 'incomplete_expired', 'trialing', 'active', 'past_due', 'canceled', 'unpaid', 'paused')
  ),
  plan_key text NOT NULL CHECK (
    plan_key = btrim(plan_key)
    AND octet_length(plan_key) BETWEEN 1 AND 64
    AND plan_key ~ '^[a-z][a-z0-9_-]*$'
  ),
  current_period_start timestamptz NOT NULL,
  current_period_end timestamptz NOT NULL,
  cancel_at_period_end boolean NOT NULL,
  canonical_digest bytea NOT NULL CHECK (octet_length(canonical_digest) = 32),
  reconcile_generation bigint NOT NULL CHECK (reconcile_generation > 0),
  canonical_retrieved_at timestamptz NOT NULL,
  source_event_id text NOT NULL,
  entitlement_snapshot_id uuid NOT NULL,
  entitlement_source_generation bigint NOT NULL CHECK (entitlement_source_generation > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, stripe_subscription_id),
  UNIQUE (stripe_livemode, stripe_subscription_id),
  UNIQUE (tenant_id, reconcile_generation),
  FOREIGN KEY (tenant_id, stripe_customer_id, stripe_livemode)
    REFERENCES public.billing_accounts (tenant_id, stripe_customer_id, stripe_livemode)
    ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, stripe_customer_id, stripe_livemode, source_event_id)
    REFERENCES public.stripe_event_inbox (tenant_id, stripe_customer_id, stripe_livemode, stripe_event_id)
    ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, entitlement_snapshot_id, entitlement_source_generation)
    REFERENCES public.entitlement_snapshots (tenant_id, snapshot_id, source_generation)
    ON DELETE RESTRICT,
  CHECK (current_period_start < current_period_end),
  CHECK (updated_at >= created_at)
);

CREATE INDEX billing_subscriptions_current_v16
  ON public.billing_subscriptions (tenant_id, reconcile_generation DESC);

CREATE FUNCTION public.guard_billing_subscription_v16()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Billing subscriptions cannot be deleted.' USING ERRCODE = '23514';
  END IF;

  IF OLD.tenant_id IS DISTINCT FROM NEW.tenant_id
    OR OLD.stripe_subscription_id IS DISTINCT FROM NEW.stripe_subscription_id
    OR OLD.stripe_customer_id IS DISTINCT FROM NEW.stripe_customer_id
    OR OLD.stripe_livemode IS DISTINCT FROM NEW.stripe_livemode
    OR OLD.created_at IS DISTINCT FROM NEW.created_at THEN
    RAISE EXCEPTION 'A billing subscription identity is immutable.' USING ERRCODE = '23514';
  END IF;

  IF NEW.reconcile_generation <= OLD.reconcile_generation THEN
    RAISE EXCEPTION 'A billing subscription reconciliation must advance monotonically.' USING ERRCODE = '23514';
  END IF;

  IF NEW.canonical_digest = OLD.canonical_digest THEN
    RAISE EXCEPTION 'A billing subscription update requires a new canonical digest.' USING ERRCODE = '23514';
  END IF;

  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END;
$function$;

CREATE TRIGGER billing_subscriptions_guard_mutation_v16
BEFORE UPDATE OR DELETE ON public.billing_subscriptions
FOR EACH ROW
EXECUTE FUNCTION public.guard_billing_subscription_v16();
