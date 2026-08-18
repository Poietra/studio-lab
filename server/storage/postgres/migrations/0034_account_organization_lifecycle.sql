CREATE TABLE public.account_organization_bootstrap_mutations (
  session_token_hash bytea NOT NULL CHECK (octet_length(session_token_hash) = 32),
  mutation_id uuid NOT NULL,
  actor_user_id uuid NOT NULL,
  organization_id text NOT NULL,
  display_name text NOT NULL CHECK (
    display_name = btrim(display_name)
    AND char_length(display_name) BETWEEN 1 AND 120
    AND display_name !~ '[[:cntrl:]]'
  ),
  expected_session_version bigint NOT NULL CHECK (expected_session_version > 0),
  resulting_session_version bigint NOT NULL CHECK (
    resulting_session_version = expected_session_version + 1
  ),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (session_token_hash, mutation_id),
  UNIQUE (organization_id),
  UNIQUE (session_token_hash, resulting_session_version),
  FOREIGN KEY (actor_user_id) REFERENCES public.users (user_id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id) REFERENCES public.organizations (tenant_id) ON DELETE RESTRICT
);

CREATE FUNCTION public.reject_account_organization_bootstrap_mutation_change_v34()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
BEGIN
  RAISE EXCEPTION 'Account organization bootstrap audit records are immutable.' USING ERRCODE = '23514';
END;
$function$;

CREATE TRIGGER account_organization_bootstrap_mutations_immutable
BEFORE UPDATE OR DELETE ON public.account_organization_bootstrap_mutations
FOR EACH ROW
EXECUTE FUNCTION public.reject_account_organization_bootstrap_mutation_change_v34();

CREATE FUNCTION public.require_account_organization_bootstrap_result_v34()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM public.organizations organization
      JOIN public.organization_memberships membership
        ON membership.tenant_id = organization.tenant_id
      JOIN public.account_sessions session
        ON session.session_token_hash = NEW.session_token_hash
       AND session.user_id = NEW.actor_user_id
     WHERE organization.tenant_id = NEW.organization_id
       AND organization.display_name = NEW.display_name
       AND organization.status = 'active'
       AND membership.user_id = NEW.actor_user_id
       AND membership.role = 'owner'
       AND membership.status = 'active'
       AND session.version = NEW.resulting_session_version
  ) THEN
    RAISE EXCEPTION 'Account organization bootstrap result does not match its owner projection.'
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$function$;

CREATE CONSTRAINT TRIGGER account_organization_bootstrap_mutations_require_result
AFTER INSERT ON public.account_organization_bootstrap_mutations
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION public.require_account_organization_bootstrap_result_v34();

CREATE TABLE public.account_membership_mutations (
  session_token_hash bytea NOT NULL CHECK (octet_length(session_token_hash) = 32),
  mutation_id uuid NOT NULL,
  actor_user_id uuid NOT NULL,
  organization_id text NOT NULL,
  member_user_id uuid NOT NULL,
  action text NOT NULL CHECK (action IN ('set-role', 'remove')),
  requested_role text CHECK (requested_role IN ('owner', 'admin', 'member', 'billing')),
  expected_membership_version bigint NOT NULL CHECK (expected_membership_version > 0),
  resulting_membership_version bigint NOT NULL CHECK (
    resulting_membership_version = expected_membership_version + 1
  ),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (session_token_hash, mutation_id),
  UNIQUE (organization_id, member_user_id, resulting_membership_version),
  FOREIGN KEY (session_token_hash) REFERENCES public.account_sessions (session_token_hash) ON DELETE RESTRICT,
  FOREIGN KEY (actor_user_id) REFERENCES public.users (user_id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, member_user_id)
    REFERENCES public.organization_memberships (tenant_id, user_id) ON DELETE RESTRICT,
  CHECK (
    (action = 'set-role' AND requested_role IS NOT NULL)
    OR (action = 'remove' AND requested_role IS NULL)
  )
);

CREATE FUNCTION public.reject_account_membership_mutation_change_v34()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
BEGIN
  RAISE EXCEPTION 'Account membership audit records are immutable.' USING ERRCODE = '23514';
END;
$function$;

CREATE TRIGGER account_membership_mutations_immutable
BEFORE UPDATE OR DELETE ON public.account_membership_mutations
FOR EACH ROW
EXECUTE FUNCTION public.reject_account_membership_mutation_change_v34();

CREATE FUNCTION public.require_account_membership_mutation_result_v34()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM public.organization_memberships membership
     WHERE membership.tenant_id = NEW.organization_id
       AND membership.user_id = NEW.member_user_id
       AND membership.version = NEW.resulting_membership_version
       AND (
         (NEW.action = 'set-role' AND membership.status = 'active' AND membership.role = NEW.requested_role)
         OR (NEW.action = 'remove' AND membership.status = 'suspended')
       )
  ) THEN
    RAISE EXCEPTION 'Account membership mutation does not match its resulting projection.'
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$function$;

CREATE CONSTRAINT TRIGGER account_membership_mutations_require_result
AFTER INSERT ON public.account_membership_mutations
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION public.require_account_membership_mutation_result_v34();
