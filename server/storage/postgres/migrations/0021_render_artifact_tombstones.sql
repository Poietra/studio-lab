ALTER TABLE public.render_artifact_deletions
  ADD COLUMN deleted_at timestamptz;

CREATE INDEX render_artifact_pending_deletion_queue_v21
  ON public.render_artifact_deletions (tenant_id, queued_at, deletion_id)
  WHERE deleted_at IS NULL;
