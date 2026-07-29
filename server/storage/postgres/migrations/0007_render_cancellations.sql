ALTER TABLE public.render_sessions
  ADD COLUMN broker_shard_id text,
  ADD CONSTRAINT render_sessions_broker_shard_format CHECK (
    broker_shard_id IS NULL
    OR (
      octet_length(broker_shard_id) BETWEEN 1 AND 240
      AND broker_shard_id ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'
    )
  ),
  ADD CONSTRAINT render_sessions_rendering_broker_shard CHECK (
    status <> 'rendering' OR broker_shard_id IS NOT NULL
  ),
  ADD CONSTRAINT render_sessions_broker_shard_key
    UNIQUE (tenant_id, session_id, broker_shard_id);

CREATE FUNCTION public.reject_render_session_broker_shard_change_v7()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
BEGIN
  RAISE EXCEPTION 'A render session broker shard is immutable.' USING ERRCODE = '23514';
END;
$function$;

CREATE TRIGGER render_sessions_broker_shard_immutable
BEFORE UPDATE OF broker_shard_id ON public.render_sessions
FOR EACH ROW
WHEN (
  OLD.broker_shard_id IS NOT NULL
  AND OLD.broker_shard_id IS DISTINCT FROM NEW.broker_shard_id
)
EXECUTE FUNCTION public.reject_render_session_broker_shard_change_v7();

CREATE TABLE public.render_cancellation_intents (
  tenant_id text NOT NULL,
  session_id uuid NOT NULL,
  broker_shard_id text NOT NULL CHECK (
    octet_length(broker_shard_id) BETWEEN 1 AND 240
    AND broker_shard_id ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'
  ),
  job_id text NOT NULL CHECK (
    octet_length(job_id) BETWEEN 1 AND 240
    AND job_id ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'
    AND job_id = tenant_id || '/' || session_id::text
  ),
  reject_until timestamptz NOT NULL,
  requested_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  delivery_owner text,
  delivery_token bigint NOT NULL DEFAULT 0 CHECK (delivery_token >= 0),
  delivery_expires_at timestamptz,
  acknowledged_at timestamptz,
  fence_digest text,
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, session_id),
  UNIQUE (tenant_id, job_id),
  FOREIGN KEY (tenant_id, session_id, broker_shard_id)
    REFERENCES public.render_sessions (tenant_id, session_id, broker_shard_id)
    ON DELETE CASCADE,
  CHECK (expires_at = reject_until + interval '30 seconds'),
  CHECK (
    (
      delivery_owner IS NULL
      AND delivery_token = 0
      AND delivery_expires_at IS NULL
    )
    OR (
      delivery_owner IS NOT NULL
      AND octet_length(delivery_owner) BETWEEN 1 AND 240
      AND delivery_owner ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]*$'
      AND delivery_token > 0
      AND delivery_expires_at IS NOT NULL
      AND delivery_expires_at > requested_at
      AND delivery_expires_at <= expires_at
    )
  ),
  CHECK ((acknowledged_at IS NULL) = (fence_digest IS NULL)),
  CHECK (
    acknowledged_at IS NULL
    OR (
      delivery_token > 0
      AND acknowledged_at >= requested_at
      AND acknowledged_at < expires_at
      AND fence_digest ~ '^[0-9a-f]{64}$'
    )
  )
);

CREATE INDEX render_cancellation_delivery_queue
  ON public.render_cancellation_intents
    (tenant_id, broker_shard_id, requested_at, session_id)
  WHERE acknowledged_at IS NULL;

CREATE INDEX render_cancellation_expiry_queue
  ON public.render_cancellation_intents (tenant_id, expires_at, session_id);

CREATE INDEX render_sessions_shard_recovery_queue
  ON public.render_sessions (tenant_id, broker_shard_id, updated_at, session_id)
  WHERE status IN ('preparing', 'rendering');

CREATE FUNCTION public.enforce_render_session_cancellation_authority_v7()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF NEW.status = 'discarded' THEN
    RAISE EXCEPTION 'A broker-bound active render cannot be abandoned.' USING ERRCODE = '23514';
  END IF;

  IF NEW.status = 'cancelled'
     AND OLD.execution_deadline + interval '30 seconds' > clock_timestamp()
     AND NOT EXISTS (
    SELECT 1
      FROM public.render_cancellation_intents cancellation
     WHERE cancellation.tenant_id = OLD.tenant_id
       AND cancellation.session_id = OLD.session_id
       AND cancellation.acknowledged_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'A broker-bound render cancellation requires its durable acknowledgement.'
      USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public.render_cancellation_intents cancellation
     WHERE cancellation.tenant_id = OLD.tenant_id
       AND cancellation.session_id = OLD.session_id
       AND cancellation.acknowledged_at IS NULL
       AND cancellation.expires_at > clock_timestamp()
  ) THEN
    RAISE EXCEPTION 'A pending render cancellation freezes terminal publication.' USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$function$;

CREATE TRIGGER render_sessions_cancellation_authority
BEFORE UPDATE OF status ON public.render_sessions
FOR EACH ROW
WHEN (
  OLD.broker_shard_id IS NOT NULL
  AND OLD.status IN ('preparing', 'rendering')
  AND OLD.status IS DISTINCT FROM NEW.status
)
EXECUTE FUNCTION public.enforce_render_session_cancellation_authority_v7();
