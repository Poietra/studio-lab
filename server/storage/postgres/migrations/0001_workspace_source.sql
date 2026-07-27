CREATE TABLE public.poietra_schema_migrations (
  version integer PRIMARY KEY,
  checksum text NOT NULL CHECK (checksum ~ '^[0-9a-f]{64}$'),
  applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE public.workspace_tenants (
  tenant_id text PRIMARY KEY CHECK (tenant_id ~ '^[a-z][a-z0-9_-]{0,63}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE public.workspace_projects (
  tenant_id text NOT NULL,
  project_id text NOT NULL CHECK (project_id ~ '^[a-z][a-z0-9_-]{0,63}$'),
  display_name text NOT NULL CHECK (
    display_name = btrim(display_name)
    AND char_length(display_name) BETWEEN 1 AND 120
  ),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  deleted_at timestamptz,
  PRIMARY KEY (tenant_id, project_id),
  FOREIGN KEY (tenant_id) REFERENCES public.workspace_tenants (tenant_id) ON DELETE RESTRICT
);

CREATE INDEX workspace_projects_active_order
  ON public.workspace_projects (tenant_id, created_at, project_id)
  WHERE deleted_at IS NULL;

CREATE TABLE public.source_blob_objects (
  tenant_id text NOT NULL,
  digest text NOT NULL CHECK (digest ~ '^[0-9a-f]{64}$'),
  object_key text NOT NULL,
  version_id text NOT NULL CHECK (char_length(version_id) BETWEEN 1 AND 1024),
  etag text NOT NULL CHECK (char_length(etag) BETWEEN 1 AND 512),
  byte_size integer NOT NULL CHECK (byte_size BETWEEN 0 AND 2097152),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, digest),
  UNIQUE (tenant_id, object_key, version_id),
  FOREIGN KEY (tenant_id) REFERENCES public.workspace_tenants (tenant_id) ON DELETE RESTRICT,
  CHECK (object_key = 'tenants/' || tenant_id || '/sources/' || digest)
);

CREATE TABLE public.workspace_source_heads (
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
  generation bigint NOT NULL CHECK (generation > 0),
  digest text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, project_id, source_path),
  FOREIGN KEY (tenant_id, project_id)
    REFERENCES public.workspace_projects (tenant_id, project_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, digest)
    REFERENCES public.source_blob_objects (tenant_id, digest) ON DELETE RESTRICT
);

CREATE TABLE public.workspace_project_references (
  tenant_id text NOT NULL,
  project_id text NOT NULL,
  reference_kind text NOT NULL CHECK (reference_kind IN ('render-job', 'render-session', 'snapshot-publication')),
  reference_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, project_id, reference_kind, reference_id),
  FOREIGN KEY (tenant_id, project_id)
    REFERENCES public.workspace_projects (tenant_id, project_id) ON DELETE RESTRICT
);

CREATE TABLE public.source_blob_deletions (
  deletion_id uuid PRIMARY KEY,
  tenant_id text NOT NULL,
  digest text NOT NULL CHECK (digest ~ '^[0-9a-f]{64}$'),
  object_key text NOT NULL,
  version_id text NOT NULL CHECK (char_length(version_id) BETWEEN 1 AND 1024),
  etag text NOT NULL CHECK (char_length(etag) BETWEEN 1 AND 512),
  byte_size integer NOT NULL CHECK (byte_size BETWEEN 0 AND 2097152),
  queued_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  deleted_at timestamptz,
  UNIQUE (tenant_id, object_key, version_id),
  FOREIGN KEY (tenant_id) REFERENCES public.workspace_tenants (tenant_id) ON DELETE RESTRICT,
  CHECK (object_key = 'tenants/' || tenant_id || '/sources/' || digest)
);

CREATE INDEX source_blob_deletions_tenant_queue
  ON public.source_blob_deletions (tenant_id, queued_at, deletion_id)
  WHERE deleted_at IS NULL;
