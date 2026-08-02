CREATE TABLE public.organization_invitations (
  invitation_id uuid PRIMARY KEY,
  tenant_id text NOT NULL,
  token_digest bytea NOT NULL UNIQUE CHECK (octet_length(token_digest) = 32),
  normalized_email text NOT NULL CHECK (
    normalized_email = btrim(normalized_email)
    AND normalized_email = lower(normalized_email)
    AND char_length(normalized_email) BETWEEN 3 AND 254
    AND normalized_email ~ '^[a-z0-9.!#$%&''*+/=?^_`{|}~-]+@[a-z0-9.-]+\.[a-z]{2,63}$'
  ),
  invited_role text NOT NULL CHECK (invited_role IN ('admin', 'member', 'billing')),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'consumed', 'revoked')),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  consumed_by uuid,
  consumed_at timestamptz,
  revoked_by uuid,
  revoked_at timestamptz,
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id) REFERENCES public.organizations (tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (created_by) REFERENCES public.users (user_id) ON DELETE RESTRICT,
  FOREIGN KEY (consumed_by) REFERENCES public.users (user_id) ON DELETE RESTRICT,
  FOREIGN KEY (revoked_by) REFERENCES public.users (user_id) ON DELETE RESTRICT,
  CHECK (
    expires_at >= created_at + interval '5 minutes'
    AND expires_at <= created_at + interval '7 days'
  ),
  CHECK (
    (status = 'pending'
      AND consumed_by IS NULL AND consumed_at IS NULL
      AND revoked_by IS NULL AND revoked_at IS NULL)
    OR (status = 'consumed'
      AND consumed_by IS NOT NULL AND consumed_at IS NOT NULL
      AND revoked_by IS NULL AND revoked_at IS NULL)
    OR (status = 'revoked'
      AND consumed_by IS NULL AND consumed_at IS NULL
      AND revoked_by IS NOT NULL AND revoked_at IS NOT NULL)
  ),
  CHECK (consumed_at IS NULL OR consumed_at >= created_at),
  CHECK (revoked_at IS NULL OR revoked_at >= created_at),
  CHECK (updated_at >= created_at)
);

CREATE INDEX organization_invitations_pending_v22
  ON public.organization_invitations (tenant_id, expires_at, invitation_id)
  WHERE status = 'pending';

CREATE FUNCTION public.guard_organization_invitation_v22()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Organization invitation audit records cannot be deleted.' USING ERRCODE = '23514';
  END IF;
  IF OLD.invitation_id IS DISTINCT FROM NEW.invitation_id
    OR OLD.tenant_id IS DISTINCT FROM NEW.tenant_id
    OR OLD.token_digest IS DISTINCT FROM NEW.token_digest
    OR OLD.normalized_email IS DISTINCT FROM NEW.normalized_email
    OR OLD.invited_role IS DISTINCT FROM NEW.invited_role
    OR OLD.created_by IS DISTINCT FROM NEW.created_by
    OR OLD.created_at IS DISTINCT FROM NEW.created_at
    OR OLD.expires_at IS DISTINCT FROM NEW.expires_at
    OR OLD.status <> 'pending'
    OR NEW.status NOT IN ('consumed', 'revoked')
  THEN
    RAISE EXCEPTION 'Organization invitation identities and terminal states are immutable.' USING ERRCODE = '23514';
  END IF;
  NEW.version := OLD.version + 1;
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END;
$function$;

CREATE TRIGGER organization_invitations_guard
BEFORE UPDATE OR DELETE ON public.organization_invitations
FOR EACH ROW
EXECUTE FUNCTION public.guard_organization_invitation_v22();

ALTER TABLE public.oidc_login_attempts
  ADD COLUMN invitation_token_digest bytea
  CHECK (invitation_token_digest IS NULL OR octet_length(invitation_token_digest) = 32),
  ADD CONSTRAINT oidc_login_attempts_invitation_v22
  FOREIGN KEY (invitation_token_digest)
  REFERENCES public.organization_invitations (token_digest)
  ON DELETE RESTRICT;

CREATE INDEX oidc_login_attempts_invitation_v22
  ON public.oidc_login_attempts (invitation_token_digest)
  WHERE invitation_token_digest IS NOT NULL;
