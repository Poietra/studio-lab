CREATE TABLE public.snapshot_artifact_objects (
  tenant_id text NOT NULL,
  result_digest text NOT NULL CHECK (result_digest ~ '^[0-9a-f]{64}$'),
  source_digest text NOT NULL CHECK (source_digest ~ '^[0-9a-f]{64}$'),
  runtime_config_hash text NOT NULL CHECK (runtime_config_hash ~ '^[0-9a-f]{64}$'),
  profile_digest text NOT NULL CHECK (profile_digest ~ '^[0-9a-f]{64}$'),
  object_key text NOT NULL,
  version_id text NOT NULL CHECK (char_length(version_id) BETWEEN 1 AND 1024),
  etag text NOT NULL CHECK (char_length(etag) BETWEEN 1 AND 512),
  byte_size integer NOT NULL CHECK (byte_size BETWEEN 1 AND 16777216),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, result_digest),
  UNIQUE (tenant_id, object_key, version_id),
  UNIQUE (tenant_id, result_digest, source_digest, runtime_config_hash, profile_digest),
  FOREIGN KEY (tenant_id, source_digest)
    REFERENCES public.source_blob_objects (tenant_id, digest) ON DELETE RESTRICT,
  CHECK (
    object_key = 'tenants/' || tenant_id || '/snapshots/' || source_digest || '/'
      || runtime_config_hash || '/' || profile_digest || '/' || result_digest
  )
);

CREATE TABLE public.snapshot_publications (
  tenant_id text NOT NULL,
  publication_id uuid NOT NULL,
  project_id text NOT NULL,
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
  scene_name text NOT NULL CHECK (scene_name ~ '^[A-Za-z_][A-Za-z0-9_]*$' AND char_length(scene_name) <= 240),
  generation bigint NOT NULL CHECK (generation BETWEEN 1 AND 9007199254740991),
  source_generation bigint NOT NULL CHECK (source_generation > 0),
  source_digest text NOT NULL CHECK (source_digest ~ '^[0-9a-f]{64}$'),
  runtime_config_hash text NOT NULL CHECK (runtime_config_hash ~ '^[0-9a-f]{64}$'),
  profile_digest text NOT NULL CHECK (profile_digest ~ '^[0-9a-f]{64}$'),
  result_digest text NOT NULL CHECK (result_digest ~ '^[0-9a-f]{64}$'),
  snapshot_hash text NOT NULL CHECK (snapshot_hash ~ '^[0-9a-f]{64}$'),
  request_id text NOT NULL CHECK (octet_length(request_id) BETWEEN 1 AND 2048),
  published_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, publication_id),
  UNIQUE (tenant_id, project_id, source_path, scene_name, generation, publication_id),
  FOREIGN KEY (tenant_id, project_id)
    REFERENCES public.workspace_projects (tenant_id, project_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, source_digest)
    REFERENCES public.source_blob_objects (tenant_id, digest) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, result_digest, source_digest, runtime_config_hash, profile_digest)
    REFERENCES public.snapshot_artifact_objects
      (tenant_id, result_digest, source_digest, runtime_config_hash, profile_digest)
    ON DELETE RESTRICT
);

CREATE TABLE public.snapshot_scene_heads (
  tenant_id text NOT NULL,
  project_id text NOT NULL,
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
  scene_name text NOT NULL CHECK (scene_name ~ '^[A-Za-z_][A-Za-z0-9_]*$' AND char_length(scene_name) <= 240),
  generation bigint NOT NULL CHECK (generation BETWEEN 1 AND 9007199254740991),
  publication_id uuid,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, project_id, source_path, scene_name),
  FOREIGN KEY (tenant_id, project_id)
    REFERENCES public.workspace_projects (tenant_id, project_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, project_id, source_path, scene_name, generation, publication_id)
    REFERENCES public.snapshot_publications
      (tenant_id, project_id, source_path, scene_name, generation, publication_id)
    ON DELETE RESTRICT
);

CREATE INDEX snapshot_publications_artifact_lookup
  ON public.snapshot_publications (tenant_id, result_digest);

CREATE INDEX snapshot_scene_heads_current_artifact
  ON public.snapshot_scene_heads (tenant_id, publication_id)
  WHERE publication_id IS NOT NULL;

CREATE TABLE public.snapshot_artifact_deletions (
  deletion_id uuid PRIMARY KEY,
  tenant_id text NOT NULL,
  result_digest text NOT NULL CHECK (result_digest ~ '^[0-9a-f]{64}$'),
  source_digest text NOT NULL CHECK (source_digest ~ '^[0-9a-f]{64}$'),
  runtime_config_hash text NOT NULL CHECK (runtime_config_hash ~ '^[0-9a-f]{64}$'),
  profile_digest text NOT NULL CHECK (profile_digest ~ '^[0-9a-f]{64}$'),
  object_key text NOT NULL,
  version_id text NOT NULL CHECK (char_length(version_id) BETWEEN 1 AND 1024),
  etag text NOT NULL CHECK (char_length(etag) BETWEEN 1 AND 512),
  byte_size integer NOT NULL CHECK (byte_size BETWEEN 1 AND 16777216),
  queued_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  deleted_at timestamptz,
  UNIQUE (tenant_id, object_key, version_id),
  FOREIGN KEY (tenant_id) REFERENCES public.workspace_tenants (tenant_id) ON DELETE RESTRICT,
  CHECK (
    object_key = 'tenants/' || tenant_id || '/snapshots/' || source_digest || '/'
      || runtime_config_hash || '/' || profile_digest || '/' || result_digest
  )
);

CREATE INDEX snapshot_artifact_deletions_tenant_queue
  ON public.snapshot_artifact_deletions (tenant_id, queued_at, deletion_id)
  WHERE deleted_at IS NULL;
