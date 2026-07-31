CREATE TABLE public.account_sessions (
  session_token_hash bytea PRIMARY KEY CHECK (octet_length(session_token_hash) = 32),
  user_id uuid NOT NULL,
  active_tenant_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (active_tenant_id, user_id)
    REFERENCES public.organization_memberships (tenant_id, user_id)
    ON DELETE CASCADE,
  CHECK (expires_at > created_at),
  CHECK (revoked_at IS NULL OR revoked_at >= created_at),
  CHECK (updated_at >= created_at)
);

CREATE TRIGGER account_sessions_advance_version
BEFORE UPDATE ON public.account_sessions
FOR EACH ROW
EXECUTE FUNCTION public.advance_account_record_version_v11();
