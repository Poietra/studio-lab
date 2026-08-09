CREATE INDEX snapshot_scene_heads_tombstone_retention_v27
  ON public.snapshot_scene_heads
    (tenant_id, updated_at, project_id, source_path, scene_name, runtime_digest, runtime_config_hash, generation)
  WHERE publication_id IS NULL;
