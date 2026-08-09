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

CREATE FUNCTION public.reject_account_organization_bootstrap_mutation_change_v30()
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
EXECUTE FUNCTION public.reject_account_organization_bootstrap_mutation_change_v30();

CREATE FUNCTION public.require_account_organization_bootstrap_result_v30()
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
EXECUTE FUNCTION public.require_account_organization_bootstrap_result_v30();
