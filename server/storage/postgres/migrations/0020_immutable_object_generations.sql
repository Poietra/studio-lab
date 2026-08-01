LOCK TABLE
  public.source_blob_objects,
  public.source_blob_deletions,
  public.snapshot_artifact_objects,
  public.snapshot_artifact_deletions,
  public.render_artifact_objects,
  public.render_artifact_deletions,
  public.project_png_objects,
  public.project_png_generations,
  public.project_png_deletions
  IN ACCESS EXCLUSIVE MODE;

ALTER TABLE public.source_blob_objects
  ADD COLUMN object_generation uuid,
  ALTER COLUMN version_id DROP NOT NULL,
  ADD CONSTRAINT source_blob_objects_locator_mode_v20 CHECK (
    num_nonnulls(version_id, object_generation) = 1
  ),
  DROP CONSTRAINT source_blob_objects_check,
  ADD CONSTRAINT source_blob_objects_immutable_key_v20 CHECK (
    object_key = 'tenants/' || tenant_id || '/sources/' || digest
      || CASE
           WHEN object_generation IS NULL THEN ''
           ELSE '/g/' || object_generation::text
         END
  ),
  ADD CONSTRAINT source_blob_objects_generation_key_v20
    UNIQUE (tenant_id, object_key, object_generation);

ALTER TABLE public.source_blob_deletions
  ADD COLUMN object_generation uuid,
  ALTER COLUMN version_id DROP NOT NULL,
  ADD CONSTRAINT source_blob_deletions_locator_mode_v20 CHECK (
    num_nonnulls(version_id, object_generation) = 1
  ),
  DROP CONSTRAINT source_blob_deletions_check,
  ADD CONSTRAINT source_blob_deletions_immutable_key_v20 CHECK (
    object_key = 'tenants/' || tenant_id || '/sources/' || digest
      || CASE
           WHEN object_generation IS NULL THEN ''
           ELSE '/g/' || object_generation::text
         END
  ),
  ADD CONSTRAINT source_blob_deletions_generation_key_v20
    UNIQUE (tenant_id, object_key, object_generation);

ALTER TABLE public.snapshot_artifact_objects
  ADD COLUMN object_generation uuid,
  ALTER COLUMN version_id DROP NOT NULL,
  ADD CONSTRAINT snapshot_artifact_objects_locator_mode_v20 CHECK (
    num_nonnulls(version_id, object_generation) = 1
  ),
  DROP CONSTRAINT snapshot_artifact_objects_runtime_object_key,
  ADD CONSTRAINT snapshot_artifact_objects_immutable_key_v20 CHECK (
    object_key = 'tenants/' || tenant_id || '/snapshots/' || source_digest || '/'
      || runtime_config_hash || '/' || profile_digest || '/'
      || CASE
           WHEN runtime_digest = repeat('0', 64) THEN ''
           ELSE runtime_digest || '/'
         END
      || result_digest
      || CASE
           WHEN object_generation IS NULL THEN ''
           ELSE '/g/' || object_generation::text
         END
  ),
  ADD CONSTRAINT snapshot_artifact_objects_generation_key_v20
    UNIQUE (tenant_id, object_key, object_generation);

ALTER TABLE public.snapshot_artifact_deletions
  ADD COLUMN object_generation uuid,
  ALTER COLUMN version_id DROP NOT NULL,
  ADD CONSTRAINT snapshot_artifact_deletions_locator_mode_v20 CHECK (
    num_nonnulls(version_id, object_generation) = 1
  ),
  DROP CONSTRAINT snapshot_artifact_deletions_runtime_object_key,
  ADD CONSTRAINT snapshot_artifact_deletions_immutable_key_v20 CHECK (
    object_key = 'tenants/' || tenant_id || '/snapshots/' || source_digest || '/'
      || runtime_config_hash || '/' || profile_digest || '/'
      || CASE
           WHEN runtime_digest = repeat('0', 64) THEN ''
           ELSE runtime_digest || '/'
         END
      || result_digest
      || CASE
           WHEN object_generation IS NULL THEN ''
           ELSE '/g/' || object_generation::text
         END
  ),
  ADD CONSTRAINT snapshot_artifact_deletions_generation_key_v20
    UNIQUE (tenant_id, object_key, object_generation);

ALTER TABLE public.render_artifact_objects
  ADD COLUMN object_generation uuid,
  ALTER COLUMN version_id DROP NOT NULL,
  ADD CONSTRAINT render_artifact_objects_locator_mode_v20 CHECK (
    num_nonnulls(version_id, object_generation) = 1
  ),
  ADD CONSTRAINT render_artifact_objects_immutable_key_v20 CHECK (
    object_key = 'tenants/' || tenant_id || '/media/' || artifact_kind || '/'
      || source_digest || '/' || runtime_digest || '/' || profile_digest || '/'
      || request_digest || '/' || artifact_digest
      || CASE
           WHEN object_generation IS NULL THEN ''
           ELSE '/g/' || object_generation::text
         END
  ),
  ADD CONSTRAINT render_artifact_objects_generation_key_v20
    UNIQUE (tenant_id, object_key, object_generation);

ALTER TABLE public.render_artifact_deletions
  ADD COLUMN object_generation uuid,
  ALTER COLUMN version_id DROP NOT NULL,
  ADD CONSTRAINT render_artifact_deletions_locator_mode_v20 CHECK (
    num_nonnulls(version_id, object_generation) = 1
  ),
  ADD CONSTRAINT render_artifact_deletions_immutable_key_v20 CHECK (
    object_key = 'tenants/' || tenant_id || '/media/' || artifact_kind || '/'
      || source_digest || '/' || runtime_digest || '/' || profile_digest || '/'
      || request_digest || '/' || artifact_digest
      || CASE
           WHEN object_generation IS NULL THEN ''
           ELSE '/g/' || object_generation::text
         END
  ),
  ADD CONSTRAINT render_artifact_deletions_generation_key_v20
    UNIQUE (tenant_id, object_key, object_generation);

ALTER TABLE public.project_png_objects
  ADD COLUMN object_locator_id bigint GENERATED ALWAYS AS IDENTITY,
  ADD COLUMN object_generation uuid,
  DROP CONSTRAINT project_png_objects_pkey,
  ADD CONSTRAINT project_png_objects_pkey PRIMARY KEY (object_locator_id),
  ADD CONSTRAINT project_png_objects_legacy_key_v20
    UNIQUE (tenant_id, object_key, version_id),
  ALTER COLUMN version_id DROP NOT NULL,
  ADD CONSTRAINT project_png_objects_locator_mode_v20 CHECK (
    num_nonnulls(version_id, object_generation) = 1
  ),
  DROP CONSTRAINT project_png_objects_check,
  ADD CONSTRAINT project_png_objects_immutable_key_v20 CHECK (
    object_key = 'tenants/' || tenant_id || '/projects/' || project_id
      || '/assets/image.png/' || digest
      || CASE
           WHEN object_generation IS NULL THEN ''
           ELSE '/g/' || object_generation::text
         END
  ),
  ADD CONSTRAINT project_png_objects_generation_identity_v20
    UNIQUE (tenant_id, project_id, digest, object_key, object_generation),
  ADD CONSTRAINT project_png_objects_generation_key_v20
    UNIQUE (tenant_id, object_key, object_generation);

ALTER TABLE public.project_png_generations
  ADD COLUMN object_generation uuid,
  ALTER COLUMN version_id DROP NOT NULL,
  ADD CONSTRAINT project_png_generations_locator_mode_v20 CHECK (
    num_nonnulls(version_id, object_generation) = 1
  ),
  ADD CONSTRAINT project_png_generations_immutable_object_fk_v20
    FOREIGN KEY (tenant_id, project_id, digest, object_key, object_generation)
    REFERENCES public.project_png_objects
      (tenant_id, project_id, digest, object_key, object_generation)
    ON DELETE RESTRICT;

CREATE INDEX project_png_generations_immutable_object_v20
  ON public.project_png_generations (tenant_id, object_key, object_generation)
  WHERE object_generation IS NOT NULL;

ALTER TABLE public.project_png_deletions
  ADD COLUMN object_generation uuid,
  ALTER COLUMN version_id DROP NOT NULL,
  ADD CONSTRAINT project_png_deletions_locator_mode_v20 CHECK (
    num_nonnulls(version_id, object_generation) = 1
  ),
  DROP CONSTRAINT project_png_deletions_check,
  ADD CONSTRAINT project_png_deletions_immutable_key_v20 CHECK (
    object_key = 'tenants/' || tenant_id || '/projects/' || project_id
      || '/assets/image.png/' || digest
      || CASE
           WHEN object_generation IS NULL THEN ''
           ELSE '/g/' || object_generation::text
         END
  ),
  ADD CONSTRAINT project_png_deletions_generation_key_v20
    UNIQUE (tenant_id, object_key, object_generation);
