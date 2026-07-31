CREATE TABLE public.billing_accounts (
  tenant_id text PRIMARY KEY,
  current_snapshot_id uuid,
  applied_generation bigint NOT NULL DEFAULT 0 CHECK (applied_generation >= 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id) REFERENCES public.organizations (tenant_id) ON DELETE RESTRICT,
  CHECK ((current_snapshot_id IS NULL) = (applied_generation = 0)),
  CHECK (updated_at >= created_at)
);

CREATE TABLE public.entitlement_snapshots (
  tenant_id text NOT NULL,
  snapshot_id uuid NOT NULL,
  source_generation bigint NOT NULL CHECK (source_generation > 0),
  plan_key text NOT NULL CHECK (
    plan_key = btrim(plan_key)
    AND octet_length(plan_key) BETWEEN 1 AND 64
    AND plan_key ~ '^[a-z][a-z0-9_-]*$'
  ),
  access_state text NOT NULL CHECK (access_state IN ('active', 'grace', 'blocked')),
  render_enabled boolean NOT NULL,
  render_job_limit integer NOT NULL CHECK (render_job_limit BETWEEN 0 AND 1000000),
  usage_period_key text NOT NULL CHECK (
    usage_period_key = btrim(usage_period_key)
    AND octet_length(usage_period_key) BETWEEN 1 AND 160
    AND usage_period_key !~ '[[:cntrl:]]'
  ),
  period_start timestamptz NOT NULL,
  access_until timestamptz NOT NULL,
  period_end timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, snapshot_id),
  UNIQUE (tenant_id, source_generation),
  UNIQUE (tenant_id, snapshot_id, source_generation),
  UNIQUE (tenant_id, snapshot_id, source_generation, usage_period_key),
  FOREIGN KEY (tenant_id) REFERENCES public.billing_accounts (tenant_id) ON DELETE RESTRICT,
  CHECK (period_start < access_until AND access_until <= period_end),
  CHECK (access_state <> 'blocked' OR render_enabled = false),
  CHECK (render_enabled = (render_job_limit > 0))
);

ALTER TABLE public.billing_accounts
  ADD CONSTRAINT billing_accounts_current_snapshot_fk
  FOREIGN KEY (tenant_id, current_snapshot_id, applied_generation)
  REFERENCES public.entitlement_snapshots (tenant_id, snapshot_id, source_generation)
  DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE public.usage_reservations (
  tenant_id text NOT NULL,
  operation_kind text NOT NULL DEFAULT 'render' CHECK (operation_kind = 'render'),
  operation_id uuid NOT NULL,
  snapshot_id uuid NOT NULL,
  source_generation bigint NOT NULL CHECK (source_generation > 0),
  usage_period_key text NOT NULL CHECK (
    usage_period_key = btrim(usage_period_key)
    AND octet_length(usage_period_key) BETWEEN 1 AND 160
    AND usage_period_key !~ '[[:cntrl:]]'
  ),
  state text NOT NULL DEFAULT 'reserved' CHECK (state IN ('reserved', 'committed', 'released')),
  expires_at timestamptz NOT NULL,
  settled_at timestamptz,
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, operation_kind, operation_id),
  UNIQUE (
    tenant_id,
    operation_kind,
    operation_id,
    snapshot_id,
    source_generation,
    usage_period_key
  ),
  FOREIGN KEY (tenant_id, snapshot_id, source_generation, usage_period_key)
    REFERENCES public.entitlement_snapshots (tenant_id, snapshot_id, source_generation, usage_period_key)
    ON DELETE RESTRICT,
  CHECK (
    expires_at >= created_at + interval '1 second'
    AND expires_at <= created_at + interval '30 minutes'
  ),
  CHECK (
    (state = 'reserved' AND settled_at IS NULL)
    OR (state IN ('committed', 'released') AND settled_at IS NOT NULL)
  ),
  CHECK (settled_at IS NULL OR (settled_at >= created_at AND settled_at <= updated_at)),
  CHECK (updated_at >= created_at)
);

CREATE INDEX usage_reservations_quota_window_v14
  ON public.usage_reservations (tenant_id, usage_period_key, state)
  WHERE state IN ('reserved', 'committed');

CREATE INDEX usage_reservations_expiry_queue_v14
  ON public.usage_reservations (expires_at, tenant_id, operation_id)
  WHERE state = 'reserved';

CREATE TABLE public.usage_events (
  tenant_id text NOT NULL,
  operation_kind text NOT NULL CHECK (operation_kind = 'render'),
  operation_id uuid NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('committed', 'released', 'expired')),
  snapshot_id uuid NOT NULL,
  source_generation bigint NOT NULL CHECK (source_generation > 0),
  usage_period_key text NOT NULL CHECK (
    usage_period_key = btrim(usage_period_key)
    AND octet_length(usage_period_key) BETWEEN 1 AND 160
    AND usage_period_key !~ '[[:cntrl:]]'
  ),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, operation_kind, operation_id),
  FOREIGN KEY (
    tenant_id,
    operation_kind,
    operation_id,
    snapshot_id,
    source_generation,
    usage_period_key
  ) REFERENCES public.usage_reservations (
    tenant_id,
    operation_kind,
    operation_id,
    snapshot_id,
    source_generation,
    usage_period_key
  ) ON DELETE RESTRICT
);

CREATE FUNCTION public.guard_billing_account_head_v14()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
DECLARE
  target_period_end timestamptz;
  target_period_start timestamptz;
  target_usage_period_key text;
BEGIN
  IF OLD.tenant_id IS DISTINCT FROM NEW.tenant_id
    OR OLD.created_at IS DISTINCT FROM NEW.created_at THEN
    RAISE EXCEPTION 'A billing account identity is immutable.' USING ERRCODE = '23514';
  END IF;

  IF NEW.applied_generation < OLD.applied_generation
    OR NEW.applied_generation > OLD.applied_generation + 1 THEN
    RAISE EXCEPTION 'A billing entitlement generation must advance exactly once.' USING ERRCODE = '23514';
  END IF;

  IF NEW.applied_generation = OLD.applied_generation
    AND NEW.current_snapshot_id IS DISTINCT FROM OLD.current_snapshot_id THEN
    RAISE EXCEPTION 'A billing entitlement head change requires a newer generation.' USING ERRCODE = '23514';
  END IF;

  IF NEW.current_snapshot_id IS NOT NULL
    AND (
      NEW.current_snapshot_id IS DISTINCT FROM OLD.current_snapshot_id
      OR NEW.applied_generation IS DISTINCT FROM OLD.applied_generation
    ) THEN
    SELECT snapshot.period_start, snapshot.period_end, snapshot.usage_period_key
      INTO target_period_start, target_period_end, target_usage_period_key
      FROM public.entitlement_snapshots snapshot
     WHERE snapshot.tenant_id = NEW.tenant_id
       AND snapshot.snapshot_id = NEW.current_snapshot_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'A billing entitlement head requires its snapshot.' USING ERRCODE = '23503';
    END IF;

    IF EXISTS (
      SELECT 1
        FROM public.entitlement_snapshots historical
       WHERE historical.tenant_id = NEW.tenant_id
         AND historical.snapshot_id <> NEW.current_snapshot_id
         AND historical.period_start < target_period_end
         AND target_period_start < historical.period_end
         AND historical.usage_period_key <> target_usage_period_key
    ) THEN
      RAISE EXCEPTION 'Overlapping entitlement periods must share one usage period key.' USING ERRCODE = '23514';
    END IF;
  END IF;

  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END;
$function$;

CREATE TRIGGER billing_accounts_guard_head_v14
BEFORE UPDATE ON public.billing_accounts
FOR EACH ROW
EXECUTE FUNCTION public.guard_billing_account_head_v14();

CREATE FUNCTION public.reject_entitlement_snapshot_mutation_v14()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
BEGIN
  RAISE EXCEPTION 'Entitlement snapshots are append-only.' USING ERRCODE = '23514';
END;
$function$;

CREATE TRIGGER entitlement_snapshots_append_only_v14
BEFORE UPDATE OR DELETE ON public.entitlement_snapshots
FOR EACH ROW
EXECUTE FUNCTION public.reject_entitlement_snapshot_mutation_v14();

CREATE FUNCTION public.guard_usage_reservation_v14()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Usage reservations cannot be deleted.' USING ERRCODE = '23514';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.state <> 'reserved' OR NEW.settled_at IS NOT NULL OR NEW.version <> 1 THEN
      RAISE EXCEPTION 'A usage reservation must begin in its reserved state.' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.tenant_id IS DISTINCT FROM NEW.tenant_id
    OR OLD.operation_kind IS DISTINCT FROM NEW.operation_kind
    OR OLD.operation_id IS DISTINCT FROM NEW.operation_id
    OR OLD.snapshot_id IS DISTINCT FROM NEW.snapshot_id
    OR OLD.source_generation IS DISTINCT FROM NEW.source_generation
    OR OLD.usage_period_key IS DISTINCT FROM NEW.usage_period_key
    OR OLD.expires_at IS DISTINCT FROM NEW.expires_at
    OR OLD.created_at IS DISTINCT FROM NEW.created_at THEN
    RAISE EXCEPTION 'A usage reservation identity is immutable.' USING ERRCODE = '23514';
  END IF;

  IF OLD.state <> 'reserved' THEN
    RAISE EXCEPTION 'A terminal usage reservation is immutable.' USING ERRCODE = '23514';
  END IF;

  IF NEW.state NOT IN ('committed', 'released') THEN
    RAISE EXCEPTION 'A usage reservation can only move to a terminal state.' USING ERRCODE = '23514';
  END IF;

  IF NEW.state = 'committed' AND OLD.expires_at <= clock_timestamp() THEN
    RAISE EXCEPTION 'An expired usage reservation cannot be committed.' USING ERRCODE = '23514';
  END IF;

  NEW.settled_at := clock_timestamp();
  NEW.version := OLD.version + 1;
  NEW.updated_at := NEW.settled_at;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER usage_reservations_guard_mutation_v14
BEFORE INSERT OR UPDATE OR DELETE ON public.usage_reservations
FOR EACH ROW
EXECUTE FUNCTION public.guard_usage_reservation_v14();

CREATE FUNCTION public.guard_usage_event_v14()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
DECLARE
  reservation_state text;
BEGIN
  SELECT reservation.state
    INTO reservation_state
    FROM public.usage_reservations reservation
   WHERE reservation.tenant_id = NEW.tenant_id
     AND reservation.operation_kind = NEW.operation_kind
     AND reservation.operation_id = NEW.operation_id
     FOR KEY SHARE;

  IF reservation_state IS NULL THEN
    RAISE EXCEPTION 'A usage event requires its usage reservation.' USING ERRCODE = '23503';
  END IF;

  IF (NEW.outcome = 'committed' AND reservation_state <> 'committed')
    OR (NEW.outcome IN ('released', 'expired') AND reservation_state <> 'released') THEN
    RAISE EXCEPTION 'A usage event outcome must match its terminal reservation.' USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$function$;

CREATE TRIGGER usage_events_guard_insert_v14
BEFORE INSERT ON public.usage_events
FOR EACH ROW
EXECUTE FUNCTION public.guard_usage_event_v14();

CREATE FUNCTION public.reject_usage_event_mutation_v14()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
BEGIN
  RAISE EXCEPTION 'Usage events are append-only.' USING ERRCODE = '23514';
END;
$function$;

CREATE TRIGGER usage_events_append_only_v14
BEFORE UPDATE OR DELETE ON public.usage_events
FOR EACH ROW
EXECUTE FUNCTION public.reject_usage_event_mutation_v14();

CREATE FUNCTION public.require_terminal_usage_event_v14()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
DECLARE
  matching_event_count bigint;
  matching_outcome text;
BEGIN
  IF NEW.state = 'reserved' THEN
    RETURN NULL;
  END IF;

  SELECT count(*), min(event.outcome)
    INTO matching_event_count, matching_outcome
    FROM public.usage_events event
   WHERE event.tenant_id = NEW.tenant_id
     AND event.operation_kind = NEW.operation_kind
     AND event.operation_id = NEW.operation_id;

  IF matching_event_count <> 1
    OR (NEW.state = 'committed' AND matching_outcome <> 'committed')
    OR (NEW.state = 'released' AND matching_outcome NOT IN ('released', 'expired')) THEN
    RAISE EXCEPTION 'A terminal usage reservation requires exactly one matching usage event.'
      USING ERRCODE = '23514';
  END IF;

  RETURN NULL;
END;
$function$;

CREATE CONSTRAINT TRIGGER usage_reservations_require_terminal_event_v14
AFTER INSERT OR UPDATE ON public.usage_reservations
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION public.require_terminal_usage_event_v14();
