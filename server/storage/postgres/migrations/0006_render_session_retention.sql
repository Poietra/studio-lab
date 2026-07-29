ALTER TABLE public.render_sessions
  ALTER COLUMN original_digest DROP NOT NULL,
  ALTER COLUMN patched_digest DROP NOT NULL,
  ADD COLUMN references_released_at timestamptz,
  ADD CONSTRAINT render_sessions_reference_release_state CHECK (
    (
      references_released_at IS NULL
      AND original_digest IS NOT NULL
      AND patched_digest IS NOT NULL
    )
    OR (
      references_released_at IS NOT NULL
      AND original_digest IS NULL
      AND patched_digest IS NULL
      AND project_png_generation IS NULL
      AND project_png_digest IS NULL
      AND lease_owner IS NULL
      AND lease_expires_at IS NULL
      AND status IN ('cancelled', 'discarded', 'failed', 'ready', 'undone')
    )
  );

ALTER TABLE public.source_blob_objects
  ADD COLUMN orphaned_at timestamptz;

ALTER TABLE public.project_png_generations
  ADD COLUMN orphaned_at timestamptz;

CREATE INDEX workspace_source_heads_blob_reference
  ON public.workspace_source_heads (tenant_id, digest);

CREATE INDEX render_sessions_original_blob_reference
  ON public.render_sessions (tenant_id, original_digest)
  WHERE original_digest IS NOT NULL;

CREATE INDEX render_sessions_patched_blob_reference
  ON public.render_sessions (tenant_id, patched_digest)
  WHERE patched_digest IS NOT NULL;

CREATE INDEX render_sessions_project_png_reference
  ON public.render_sessions (tenant_id, project_id, project_png_generation, project_png_digest)
  WHERE project_png_generation IS NOT NULL;

CREATE INDEX snapshot_artifact_objects_source_reference
  ON public.snapshot_artifact_objects (tenant_id, source_digest);

CREATE INDEX snapshot_publications_source_reference
  ON public.snapshot_publications (tenant_id, source_digest);

CREATE INDEX render_artifact_objects_source_reference
  ON public.render_artifact_objects (tenant_id, source_digest);

WITH migration_clock AS (
  SELECT clock_timestamp() AS orphaned_at
)
UPDATE public.source_blob_objects AS blob
   SET orphaned_at = migration_clock.orphaned_at
  FROM migration_clock
 WHERE NOT EXISTS (
         SELECT 1
           FROM public.workspace_source_heads AS head
          WHERE head.tenant_id = blob.tenant_id
            AND head.digest = blob.digest
       )
   AND NOT EXISTS (
         SELECT 1
           FROM public.render_sessions AS session
          WHERE session.tenant_id = blob.tenant_id
            AND (session.original_digest = blob.digest OR session.patched_digest = blob.digest)
       )
   AND NOT EXISTS (
         SELECT 1
           FROM public.snapshot_artifact_objects AS artifact
          WHERE artifact.tenant_id = blob.tenant_id
            AND artifact.source_digest = blob.digest
       )
   AND NOT EXISTS (
         SELECT 1
           FROM public.snapshot_publications AS publication
          WHERE publication.tenant_id = blob.tenant_id
            AND publication.source_digest = blob.digest
       )
   AND NOT EXISTS (
         SELECT 1
           FROM public.render_artifact_objects AS artifact
          WHERE artifact.tenant_id = blob.tenant_id
            AND artifact.source_digest = blob.digest
       );

WITH migration_clock AS (
  SELECT clock_timestamp() AS orphaned_at
)
UPDATE public.project_png_generations AS generation
   SET orphaned_at = migration_clock.orphaned_at
  FROM migration_clock
 WHERE NOT EXISTS (
         SELECT 1
           FROM public.project_png_heads AS head
          WHERE head.tenant_id = generation.tenant_id
            AND head.project_id = generation.project_id
            AND head.generation = generation.generation
            AND head.digest = generation.digest
       )
   AND NOT EXISTS (
         SELECT 1
           FROM public.render_sessions AS session
          WHERE session.tenant_id = generation.tenant_id
            AND session.project_id = generation.project_id
            AND session.project_png_generation = generation.generation
            AND session.project_png_digest = generation.digest
       );

CREATE INDEX render_sessions_terminal_retention_queue
  ON public.render_sessions (tenant_id, updated_at, session_id)
  WHERE references_released_at IS NULL
    AND status IN ('cancelled', 'discarded', 'failed', 'ready', 'undone');

CREATE INDEX render_sessions_released_purge_queue
  ON public.render_sessions (tenant_id, references_released_at, session_id)
  WHERE references_released_at IS NOT NULL;

CREATE INDEX source_blob_objects_orphan_queue
  ON public.source_blob_objects (tenant_id, orphaned_at, digest)
  WHERE orphaned_at IS NOT NULL;

CREATE INDEX source_blob_objects_unmarked_queue
  ON public.source_blob_objects (tenant_id, created_at, digest)
  WHERE orphaned_at IS NULL;

CREATE INDEX project_png_generations_orphan_queue
  ON public.project_png_generations (tenant_id, orphaned_at, project_id, generation)
  WHERE orphaned_at IS NOT NULL;
