CREATE TABLE public.editor_documents (
  tenant_id text NOT NULL,
  project_id text NOT NULL,
  document_key bytea NOT NULL CHECK (octet_length(document_key) = 32),
  epoch uuid NOT NULL,
  source_path text NOT NULL CHECK (
    right(source_path, 3) = '.py'
    AND source_path !~ '[[:cntrl:]]'
    AND strpos(source_path, chr(92)) = 0
    AND source_path !~ '^[A-Za-z]:'
    AND source_path NOT LIKE '/%'
    AND source_path NOT LIKE '%//%'
    AND source_path !~ '(^|/)[.]{1,2}(/|$)'
    AND char_length(source_path) <= 500
  ),
  source_hash bytea NOT NULL CHECK (octet_length(source_hash) = 32),
  revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
  opened_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  sealed_at timestamptz,
  PRIMARY KEY (tenant_id, project_id, document_key, epoch),
  CONSTRAINT editor_documents_project_fkey_v17
    FOREIGN KEY (tenant_id, project_id)
    REFERENCES public.workspace_projects (tenant_id, project_id)
    ON DELETE RESTRICT,
  CHECK (updated_at >= opened_at),
  CHECK (sealed_at IS NULL OR sealed_at >= opened_at)
);

CREATE UNIQUE INDEX editor_documents_open_identity_v17
  ON public.editor_documents (tenant_id, project_id, document_key)
  WHERE sealed_at IS NULL;

CREATE TABLE public.editor_edit_events (
  tenant_id text NOT NULL,
  project_id text NOT NULL,
  document_key bytea NOT NULL CHECK (octet_length(document_key) = 32),
  epoch uuid NOT NULL,
  base_revision bigint NOT NULL CHECK (base_revision >= 0),
  revision bigint NOT NULL CHECK (revision > 0),
  subject_id uuid NOT NULL,
  client_mutation_id uuid NOT NULL,
  canonical_program jsonb NOT NULL CHECK (jsonb_typeof(canonical_program) = 'object'),
  canonical_digest bytea NOT NULL CHECK (octet_length(canonical_digest) = 32),
  canonical_byte_size integer NOT NULL CHECK (canonical_byte_size BETWEEN 2 AND 262144),
  committed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, project_id, document_key, epoch, revision),
  CONSTRAINT editor_edit_events_actor_mutation_unique_v17
    UNIQUE (tenant_id, project_id, subject_id, client_mutation_id),
  CONSTRAINT editor_edit_events_document_fkey_v17
    FOREIGN KEY (tenant_id, project_id, document_key, epoch)
    REFERENCES public.editor_documents (tenant_id, project_id, document_key, epoch)
    ON DELETE RESTRICT,
  CONSTRAINT editor_edit_events_subject_fkey_v17
    FOREIGN KEY (subject_id) REFERENCES public.users (user_id) ON DELETE RESTRICT,
  CONSTRAINT editor_edit_events_exact_revision_v17 CHECK (revision = base_revision + 1)
);

CREATE FUNCTION public.guard_editor_document_mutation_v17()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.revision <> 0 OR NEW.sealed_at IS NOT NULL THEN
      RAISE EXCEPTION 'A new editor document must start as an open revision-zero epoch.' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Editor documents cannot be deleted.' USING ERRCODE = '23514';
  END IF;

  IF OLD.tenant_id IS DISTINCT FROM NEW.tenant_id
    OR OLD.project_id IS DISTINCT FROM NEW.project_id
    OR OLD.document_key IS DISTINCT FROM NEW.document_key
    OR OLD.epoch IS DISTINCT FROM NEW.epoch
    OR OLD.source_path IS DISTINCT FROM NEW.source_path
    OR OLD.source_hash IS DISTINCT FROM NEW.source_hash
    OR OLD.opened_at IS DISTINCT FROM NEW.opened_at THEN
    RAISE EXCEPTION 'An editor document identity is immutable.' USING ERRCODE = '23514';
  END IF;

  IF OLD.sealed_at IS NOT NULL THEN
    RAISE EXCEPTION 'A sealed editor document is immutable.' USING ERRCODE = '23514';
  END IF;

  IF NEW.revision = OLD.revision + 1 THEN
    IF NEW.sealed_at IS NOT NULL THEN
      RAISE EXCEPTION 'An editor document cannot advance and seal in one update.' USING ERRCODE = '23514';
    END IF;

    IF NOT EXISTS (
      SELECT 1
        FROM public.editor_edit_events event
       WHERE event.tenant_id = OLD.tenant_id
         AND event.project_id = OLD.project_id
         AND event.document_key = OLD.document_key
         AND event.epoch = OLD.epoch
         AND event.base_revision = OLD.revision
         AND event.revision = NEW.revision
    ) THEN
      RAISE EXCEPTION 'An editor document revision requires its matching edit event.' USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.revision = OLD.revision THEN
    IF NEW.sealed_at IS NULL THEN
      RAISE EXCEPTION 'An editor document update must advance its revision or seal the epoch.' USING ERRCODE = '23514';
    END IF;
  ELSE
    RAISE EXCEPTION 'An editor document revision must advance exactly once.' USING ERRCODE = '23514';
  END IF;

  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END;
$function$;

CREATE TRIGGER editor_documents_guard_mutation_v17
BEFORE INSERT OR UPDATE OR DELETE ON public.editor_documents
FOR EACH ROW
EXECUTE FUNCTION public.guard_editor_document_mutation_v17();

CREATE FUNCTION public.guard_editor_edit_event_mutation_v17()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
BEGIN
  RAISE EXCEPTION 'Editor edit events are append-only.' USING ERRCODE = '23514';
END;
$function$;

CREATE TRIGGER editor_edit_events_guard_mutation_v17
BEFORE UPDATE OR DELETE ON public.editor_edit_events
FOR EACH ROW
EXECUTE FUNCTION public.guard_editor_edit_event_mutation_v17();

CREATE FUNCTION public.require_editor_edit_event_document_revision_v17()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM public.editor_documents document
     WHERE document.tenant_id = NEW.tenant_id
       AND document.project_id = NEW.project_id
       AND document.document_key = NEW.document_key
       AND document.epoch = NEW.epoch
       AND document.revision >= NEW.revision
  ) THEN
    RAISE EXCEPTION 'An editor edit event requires its document revision.' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$function$;

-- An edit event is inserted before its document head advances. Deferring this
-- side of the invariant permits that ordering while rejecting an event that is
-- not paired with the matching document update before commit.
CREATE CONSTRAINT TRIGGER editor_edit_events_require_document_revision_v17
AFTER INSERT ON public.editor_edit_events
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION public.require_editor_edit_event_document_revision_v17();
