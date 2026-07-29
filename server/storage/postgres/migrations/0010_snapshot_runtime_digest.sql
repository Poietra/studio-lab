LOCK TABLE
  public.snapshot_artifact_objects,
  public.snapshot_artifact_deletions,
  public.snapshot_publications,
  public.snapshot_scene_heads,
  public.workspace_project_references
  IN ACCESS EXCLUSIVE MODE;

DELETE FROM public.workspace_project_references
 WHERE reference_kind = 'snapshot-publication';

DELETE FROM public.snapshot_scene_heads;
DELETE FROM public.snapshot_publications;

ALTER TABLE public.snapshot_publications
  DROP CONSTRAINT snapshot_publications_tenant_id_result_digest_source_diges_fkey;

ALTER TABLE public.snapshot_artifact_objects
  ADD COLUMN runtime_digest text;

UPDATE public.snapshot_artifact_objects
   SET runtime_digest = repeat('0', 64);

ALTER TABLE public.snapshot_artifact_objects
  ALTER COLUMN runtime_digest SET NOT NULL,
  DROP CONSTRAINT snapshot_artifact_objects_pkey,
  DROP CONSTRAINT snapshot_artifact_objects_tenant_id_result_digest_source_di_key,
  ADD CONSTRAINT snapshot_artifact_objects_runtime_digest_check
    CHECK (runtime_digest ~ '^[0-9a-f]{64}$'),
  DROP CONSTRAINT snapshot_artifact_objects_check,
  ADD CONSTRAINT snapshot_artifact_objects_runtime_object_key CHECK (
    (
      runtime_digest = repeat('0', 64)
      AND object_key = 'tenants/' || tenant_id || '/snapshots/' || source_digest || '/'
        || runtime_config_hash || '/' || profile_digest || '/' || result_digest
    )
    OR (
      runtime_digest <> repeat('0', 64)
      AND object_key = 'tenants/' || tenant_id || '/snapshots/' || source_digest || '/'
        || runtime_config_hash || '/' || profile_digest || '/' || runtime_digest || '/' || result_digest
    )
  ),
  ADD CONSTRAINT snapshot_artifact_objects_pkey PRIMARY KEY
    (tenant_id, runtime_digest, result_digest),
  ADD CONSTRAINT snapshot_artifact_objects_runtime_identity UNIQUE
    (tenant_id, result_digest, source_digest, runtime_config_hash, profile_digest, runtime_digest);

ALTER TABLE public.snapshot_artifact_deletions
  ADD COLUMN runtime_digest text;

UPDATE public.snapshot_artifact_deletions
   SET runtime_digest = repeat('0', 64);

ALTER TABLE public.snapshot_artifact_deletions
  ALTER COLUMN runtime_digest SET NOT NULL,
  ADD CONSTRAINT snapshot_artifact_deletions_runtime_digest_check
    CHECK (runtime_digest ~ '^[0-9a-f]{64}$'),
  DROP CONSTRAINT snapshot_artifact_deletions_check,
  ADD CONSTRAINT snapshot_artifact_deletions_runtime_object_key CHECK (
    (
      runtime_digest = repeat('0', 64)
      AND object_key = 'tenants/' || tenant_id || '/snapshots/' || source_digest || '/'
        || runtime_config_hash || '/' || profile_digest || '/' || result_digest
    )
    OR (
      runtime_digest <> repeat('0', 64)
      AND object_key = 'tenants/' || tenant_id || '/snapshots/' || source_digest || '/'
        || runtime_config_hash || '/' || profile_digest || '/' || runtime_digest || '/' || result_digest
    )
  );

ALTER TABLE public.snapshot_publications
  ADD COLUMN runtime_digest text NOT NULL,
  ADD CONSTRAINT snapshot_publications_runtime_digest_check CHECK (
    runtime_digest ~ '^[0-9a-f]{64}$'
    AND runtime_digest <> repeat('0', 64)
  ),
  ADD CONSTRAINT snapshot_publications_runtime_identity UNIQUE
    (tenant_id, project_id, source_path, scene_name, generation, publication_id, runtime_digest),
  ADD CONSTRAINT snapshot_publications_runtime_artifact_fkey FOREIGN KEY
    (tenant_id, result_digest, source_digest, runtime_config_hash, profile_digest, runtime_digest)
    REFERENCES public.snapshot_artifact_objects
      (tenant_id, result_digest, source_digest, runtime_config_hash, profile_digest, runtime_digest)
    ON DELETE RESTRICT;

ALTER TABLE public.snapshot_scene_heads
  DROP CONSTRAINT snapshot_scene_heads_tenant_id_project_id_source_path_scen_fkey,
  DROP CONSTRAINT snapshot_scene_heads_pkey,
  ADD COLUMN runtime_digest text NOT NULL,
  ADD CONSTRAINT snapshot_scene_heads_runtime_digest_check CHECK (
    runtime_digest ~ '^[0-9a-f]{64}$'
    AND runtime_digest <> repeat('0', 64)
  ),
  ADD CONSTRAINT snapshot_scene_heads_pkey PRIMARY KEY
    (tenant_id, project_id, source_path, scene_name, runtime_digest),
  ADD CONSTRAINT snapshot_scene_heads_runtime_publication_fkey FOREIGN KEY
    (tenant_id, project_id, source_path, scene_name, generation, publication_id, runtime_digest)
    REFERENCES public.snapshot_publications
      (tenant_id, project_id, source_path, scene_name, generation, publication_id, runtime_digest)
    ON DELETE RESTRICT;
