ALTER TABLE public.editor_edit_events
  ADD COLUMN mutation_kind text NOT NULL DEFAULT 'append',
  ADD COLUMN target_transaction_id text DEFAULT NULL,
  ALTER COLUMN canonical_program SET NOT NULL,
  ADD CONSTRAINT editor_edit_events_mutation_kind_closed_v18
    CHECK (mutation_kind IN ('append', 'replace', 'remove')),
  ADD CONSTRAINT editor_edit_events_mutation_target_v18 CHECK (
    (mutation_kind = 'append' AND target_transaction_id IS NULL)
    OR (
      mutation_kind IN ('replace', 'remove')
      AND target_transaction_id IS NOT NULL
      AND char_length(target_transaction_id) BETWEEN 1 AND 160
    )
  );

-- Adding the columns above holds an access-exclusive table lock until this
-- migration commits. Validate the v17 append-only ledger under that lock so
-- no legacy writer can race the cutover and leave a history the strict v18
-- fold cannot replay.
DO $function$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM public.editor_edit_events event
     WHERE jsonb_typeof(event.canonical_program -> 'transactionId') IS DISTINCT FROM 'string'
        OR char_length(event.canonical_program ->> 'transactionId') NOT BETWEEN 1 AND 160
        OR jsonb_typeof(event.canonical_program -> 'anchor') IS DISTINCT FROM 'object'
        OR jsonb_typeof(event.canonical_program #> '{anchor,resolvedSeconds}') IS DISTINCT FROM 'number'
        OR (event.canonical_program #>> '{anchor,resolvedSeconds}')::numeric < 0
        OR (event.canonical_program #>> '{anchor,resolvedSeconds}')::numeric
             > 1.7976931348623157e308::numeric
  ) THEN
    RAISE EXCEPTION 'Legacy editor events contain invalid append-fold identity or source-anchor fields.'
      USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public.editor_edit_events event
     GROUP BY event.tenant_id, event.project_id, event.document_key, event.epoch
    HAVING count(*) > 32
  ) THEN
    RAISE EXCEPTION 'Legacy editor event history exceeds the 32 Program append-fold limit.'
      USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public.editor_edit_events event
     GROUP BY event.tenant_id, event.project_id, event.document_key, event.epoch,
              event.canonical_program ->> 'transactionId'
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'Legacy editor event history contains duplicate transaction identities.'
      USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM (
        SELECT
          (event.canonical_program #>> '{anchor,resolvedSeconds}')::double precision AS resolved_seconds,
          lag((event.canonical_program #>> '{anchor,resolvedSeconds}')::double precision) OVER (
            PARTITION BY event.tenant_id, event.project_id, event.document_key, event.epoch
            ORDER BY event.revision
          ) AS previous_resolved_seconds
        FROM public.editor_edit_events event
      ) ordered
     WHERE ordered.previous_resolved_seconds IS NOT NULL
       AND ordered.resolved_seconds < ordered.previous_resolved_seconds - 0.0005::double precision
  ) THEN
    RAISE EXCEPTION 'Legacy editor event history is outside canonical source order.'
      USING ERRCODE = '23514';
  END IF;
END;
$function$;

-- Existing compatible v17 rows keep their backfilled append classification.
-- Removing the default makes every post-cutover writer name its semantics;
-- an old v17 binary now fails closed instead of extending an invalid ledger.
ALTER TABLE public.editor_edit_events
  ALTER COLUMN mutation_kind DROP DEFAULT;

-- This is a rebuildable fold checkpoint for the immutable event ledger, not a
-- second source of truth. It intentionally starts empty so the v18 repository
-- can lazily materialize a compatible legacy history after cutover.
CREATE TABLE public.editor_document_projections (
  tenant_id text NOT NULL,
  project_id text NOT NULL,
  document_key bytea NOT NULL CHECK (octet_length(document_key) = 32),
  epoch uuid NOT NULL,
  revision bigint NOT NULL CHECK (revision >= 0),
  canonical_programs jsonb NOT NULL CHECK (
    CASE
      WHEN jsonb_typeof(canonical_programs) = 'array'
        THEN jsonb_array_length(canonical_programs) <= 32
      ELSE false
    END
  ),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, project_id, document_key, epoch),
  CONSTRAINT editor_document_projections_document_fkey_v18
    FOREIGN KEY (tenant_id, project_id, document_key, epoch)
    REFERENCES public.editor_documents (tenant_id, project_id, document_key, epoch)
    ON DELETE RESTRICT,
  CONSTRAINT editor_document_projections_serialized_size_v18
    CHECK (octet_length(canonical_programs::text) <= 9437184)
);

-- The v17 append-only trigger continues to protect every event column,
-- including the mutation semantics added above.
