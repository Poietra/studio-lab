CREATE TABLE public.users (
  user_id uuid PRIMARY KEY,
  oidc_issuer text NOT NULL CHECK (
    oidc_issuer = btrim(oidc_issuer)
    AND char_length(oidc_issuer) BETWEEN 1 AND 2048
    AND oidc_issuer !~ '[[:cntrl:]]'
  ),
  oidc_subject text NOT NULL CHECK (
    oidc_subject = btrim(oidc_subject)
    AND char_length(oidc_subject) BETWEEN 1 AND 255
    AND oidc_subject !~ '[[:cntrl:]]'
  ),
  display_name text NOT NULL CHECK (
    display_name = btrim(display_name)
    AND char_length(display_name) BETWEEN 1 AND 120
    AND display_name !~ '[[:cntrl:]]'
  ),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (oidc_issuer, oidc_subject),
  CHECK (updated_at >= created_at)
);

CREATE TABLE public.organizations (
  tenant_id text PRIMARY KEY,
  display_name text NOT NULL CHECK (
    display_name = btrim(display_name)
    AND char_length(display_name) BETWEEN 1 AND 120
    AND display_name !~ '[[:cntrl:]]'
  ),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id) REFERENCES public.workspace_tenants (tenant_id) ON DELETE RESTRICT,
  CHECK (updated_at >= created_at)
);

CREATE TABLE public.organization_memberships (
  tenant_id text NOT NULL,
  user_id uuid NOT NULL,
  role text NOT NULL CHECK (role IN ('owner', 'admin', 'member', 'billing')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, user_id),
  FOREIGN KEY (tenant_id) REFERENCES public.organizations (tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (user_id) REFERENCES public.users (user_id) ON DELETE RESTRICT,
  CHECK (updated_at >= created_at)
);

CREATE INDEX organization_memberships_user_active
  ON public.organization_memberships (user_id, tenant_id)
  WHERE status = 'active';

CREATE FUNCTION public.reject_organization_delete_v11()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
BEGIN
  RAISE EXCEPTION 'Organizations require an explicit tenant purge workflow.' USING ERRCODE = '23514';
END;
$function$;

CREATE TRIGGER organizations_require_explicit_purge
BEFORE DELETE ON public.organizations
FOR EACH ROW
EXECUTE FUNCTION public.reject_organization_delete_v11();

CREATE FUNCTION public.reject_user_oidc_identity_change_v11()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
BEGIN
  RAISE EXCEPTION 'A user OIDC identity is immutable.' USING ERRCODE = '23514';
END;
$function$;

CREATE TRIGGER users_oidc_identity_immutable
BEFORE UPDATE OF oidc_issuer, oidc_subject ON public.users
FOR EACH ROW
WHEN (
  OLD.oidc_issuer IS DISTINCT FROM NEW.oidc_issuer
  OR OLD.oidc_subject IS DISTINCT FROM NEW.oidc_subject
)
EXECUTE FUNCTION public.reject_user_oidc_identity_change_v11();

CREATE FUNCTION public.advance_account_record_version_v11()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
BEGIN
  NEW.version := OLD.version + 1;
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END;
$function$;

CREATE TRIGGER users_advance_version
BEFORE UPDATE ON public.users
FOR EACH ROW
EXECUTE FUNCTION public.advance_account_record_version_v11();

CREATE TRIGGER organizations_advance_version
BEFORE UPDATE ON public.organizations
FOR EACH ROW
EXECUTE FUNCTION public.advance_account_record_version_v11();

CREATE TRIGGER organization_memberships_advance_version
BEFORE UPDATE ON public.organization_memberships
FOR EACH ROW
EXECUTE FUNCTION public.advance_account_record_version_v11();

CREATE FUNCTION public.lock_user_owned_organizations_v11()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
BEGIN
  PERFORM organization.tenant_id
    FROM public.organizations organization
    JOIN public.organization_memberships membership
      ON membership.tenant_id = organization.tenant_id
   WHERE membership.user_id = OLD.user_id
     AND membership.role = 'owner'
     AND membership.status = 'active'
   ORDER BY organization.tenant_id
     FOR UPDATE OF organization;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER users_serialize_owner_status_changes
BEFORE UPDATE OF status ON public.users
FOR EACH ROW
WHEN (OLD.status IS DISTINCT FROM NEW.status)
EXECUTE FUNCTION public.lock_user_owned_organizations_v11();

CREATE FUNCTION public.lock_organization_membership_change_v11()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
DECLARE
  target_tenant_id text;
BEGIN
  IF TG_OP = 'UPDATE' AND (
    OLD.tenant_id IS DISTINCT FROM NEW.tenant_id
    OR OLD.user_id IS DISTINCT FROM NEW.user_id
  ) THEN
    RAISE EXCEPTION 'An organization membership identity is immutable.' USING ERRCODE = '23514';
  END IF;

  target_tenant_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.tenant_id ELSE NEW.tenant_id END;
  PERFORM tenant_id
    FROM public.organizations
   WHERE tenant_id = target_tenant_id
     FOR UPDATE;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER organization_memberships_serialize_changes
BEFORE INSERT OR UPDATE OR DELETE ON public.organization_memberships
FOR EACH ROW
EXECUTE FUNCTION public.lock_organization_membership_change_v11();

CREATE FUNCTION public.require_organization_active_owner_v11()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
DECLARE
  target_tenant_id text;
BEGIN
  target_tenant_id := CASE
    WHEN TG_TABLE_NAME = 'organizations' THEN NEW.tenant_id
    WHEN TG_OP = 'DELETE' THEN OLD.tenant_id
    ELSE NEW.tenant_id
  END;

  IF EXISTS (
    SELECT 1 FROM public.organizations organization WHERE organization.tenant_id = target_tenant_id
  ) AND NOT EXISTS (
    SELECT 1
      FROM public.organization_memberships membership
      JOIN public.users owner ON owner.user_id = membership.user_id
     WHERE membership.tenant_id = target_tenant_id
       AND membership.role = 'owner'
       AND membership.status = 'active'
       AND owner.status = 'active'
  ) THEN
    RAISE EXCEPTION 'An organization requires at least one active owner.' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$function$;

CREATE FUNCTION public.require_user_owned_organizations_active_owner_v11()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM public.organization_memberships affected_membership
     WHERE affected_membership.user_id = NEW.user_id
       AND affected_membership.role = 'owner'
       AND affected_membership.status = 'active'
       AND NOT EXISTS (
         SELECT 1
           FROM public.organization_memberships membership
           JOIN public.users owner ON owner.user_id = membership.user_id
          WHERE membership.tenant_id = affected_membership.tenant_id
            AND membership.role = 'owner'
            AND membership.status = 'active'
            AND owner.status = 'active'
       )
  ) THEN
    RAISE EXCEPTION 'A user status change cannot disable the last active organization owner.'
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$function$;

-- Organization creation must insert its first active owner in the same
-- transaction. The deferred checks also permit an atomic owner transfer while
-- rejecting a transaction that removes or suspends the last active owner.
CREATE CONSTRAINT TRIGGER organizations_require_active_owner
AFTER INSERT OR UPDATE ON public.organizations
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION public.require_organization_active_owner_v11();

CREATE CONSTRAINT TRIGGER organization_memberships_require_active_owner
AFTER INSERT OR UPDATE OR DELETE ON public.organization_memberships
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION public.require_organization_active_owner_v11();

CREATE CONSTRAINT TRIGGER users_require_owned_organizations_active_owner
AFTER UPDATE OF status ON public.users
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
WHEN (OLD.status IS DISTINCT FROM NEW.status)
EXECUTE FUNCTION public.require_user_owned_organizations_active_owner_v11();
