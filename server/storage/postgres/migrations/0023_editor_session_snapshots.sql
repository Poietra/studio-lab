ALTER TABLE public.editor_edit_events
  ADD COLUMN session_base_generation bigint,
  ADD COLUMN session_generation bigint,
  ADD COLUMN session_snapshot_version integer,
  ADD COLUMN session_snapshot_digest bytea,
  ADD COLUMN session_snapshot_byte_size integer,
  ADD CONSTRAINT editor_edit_events_session_evidence_v23 CHECK (
    (
      session_base_generation IS NULL
      AND session_generation IS NULL
      AND session_snapshot_version IS NULL
      AND session_snapshot_digest IS NULL
      AND session_snapshot_byte_size IS NULL
    )
    OR (
      session_base_generation IS NOT NULL
      AND session_base_generation >= 0
      AND session_generation IS NOT NULL
      AND session_generation = session_base_generation + 1
      AND session_snapshot_version IS NOT NULL
      AND session_snapshot_version = 1
      AND session_snapshot_digest IS NOT NULL
      AND octet_length(session_snapshot_digest) = 32
      AND session_snapshot_byte_size IS NOT NULL
      AND session_snapshot_byte_size BETWEEN 2 AND 393216
    )
  );

CREATE TABLE public.editor_session_snapshots (
  tenant_id text NOT NULL,
  project_id text NOT NULL,
  document_key bytea NOT NULL CHECK (octet_length(document_key) = 32),
  subject_id uuid NOT NULL,
  epoch uuid NOT NULL,
  document_revision bigint NOT NULL CHECK (document_revision >= 0),
  session_generation bigint NOT NULL CHECK (session_generation > 0),
  snapshot_version integer NOT NULL CHECK (snapshot_version = 1),
  snapshot json NOT NULL CHECK (
    json_typeof(snapshot) = 'object'
    AND octet_length(snapshot::text) <= 393216
  ),
  snapshot_digest bytea NOT NULL CHECK (octet_length(snapshot_digest) = 32),
  snapshot_byte_size integer NOT NULL CHECK (snapshot_byte_size BETWEEN 2 AND 393216),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, project_id, document_key, subject_id),
  CONSTRAINT editor_session_snapshots_document_fkey_v23
    FOREIGN KEY (tenant_id, project_id, document_key, epoch)
    REFERENCES public.editor_documents (tenant_id, project_id, document_key, epoch)
    ON DELETE RESTRICT,
  CONSTRAINT editor_session_snapshots_subject_fkey_v23
    FOREIGN KEY (tenant_id, subject_id)
    REFERENCES public.organization_memberships (tenant_id, user_id)
    ON DELETE CASCADE,
  CONSTRAINT editor_session_snapshots_exact_byte_size_v23
    CHECK (snapshot_byte_size = octet_length(snapshot::text))
);

CREATE INDEX editor_session_snapshots_recent_subject_v23
  ON public.editor_session_snapshots
    (tenant_id, subject_id, updated_at DESC, project_id, document_key);

CREATE FUNCTION public.guard_editor_session_snapshot_mutation_v23()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.session_generation <> 1 THEN
      RAISE EXCEPTION 'A new editor session snapshot must start at generation one.' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.tenant_id IS DISTINCT FROM NEW.tenant_id
    OR OLD.project_id IS DISTINCT FROM NEW.project_id
    OR OLD.document_key IS DISTINCT FROM NEW.document_key
    OR OLD.subject_id IS DISTINCT FROM NEW.subject_id THEN
    RAISE EXCEPTION 'An editor session snapshot identity is immutable.' USING ERRCODE = '23514';
  END IF;

  IF NEW.epoch = OLD.epoch THEN
    IF NEW.session_generation <> OLD.session_generation + 1 THEN
      RAISE EXCEPTION 'An editor session generation must advance exactly once.' USING ERRCODE = '23514';
    END IF;
    IF NEW.document_revision < OLD.document_revision THEN
      RAISE EXCEPTION 'An editor session document revision cannot move backwards.' USING ERRCODE = '23514';
    END IF;
  ELSE
    IF NEW.session_generation <> 1 THEN
      RAISE EXCEPTION 'A replacement editor session epoch must restart at generation one.' USING ERRCODE = '23514';
    END IF;
  END IF;

  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END;
$function$;

CREATE TRIGGER editor_session_snapshots_guard_mutation_v23
BEFORE INSERT OR UPDATE ON public.editor_session_snapshots
FOR EACH ROW
EXECUTE FUNCTION public.guard_editor_session_snapshot_mutation_v23();
