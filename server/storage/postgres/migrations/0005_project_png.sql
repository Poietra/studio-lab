CREATE TABLE public.project_png_objects (
  tenant_id text NOT NULL,
  project_id text NOT NULL,
  digest text NOT NULL CHECK (digest ~ '^[0-9a-f]{64}$'),
  object_key text NOT NULL CHECK (octet_length(object_key) BETWEEN 1 AND 1024),
  version_id text NOT NULL CHECK (octet_length(version_id) BETWEEN 1 AND 1024),
  etag text NOT NULL CHECK (octet_length(etag) BETWEEN 1 AND 512),
  byte_size integer NOT NULL CHECK (byte_size BETWEEN 1 AND 524288),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, object_key, version_id),
  UNIQUE (tenant_id, project_id, digest, object_key, version_id),
  FOREIGN KEY (tenant_id, project_id)
    REFERENCES public.workspace_projects (tenant_id, project_id) ON DELETE RESTRICT,
  CHECK (
    object_key = 'tenants/' || tenant_id || '/projects/' || project_id || '/assets/image.png/' || digest
  )
);

CREATE TABLE public.project_png_generations (
  tenant_id text NOT NULL,
  project_id text NOT NULL,
  generation bigint NOT NULL CHECK (generation BETWEEN 1 AND 9223372036854775807),
  digest text NOT NULL CHECK (digest ~ '^[0-9a-f]{64}$'),
  object_key text NOT NULL CHECK (octet_length(object_key) BETWEEN 1 AND 1024),
  version_id text NOT NULL CHECK (octet_length(version_id) BETWEEN 1 AND 1024),
  published_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, project_id, generation),
  UNIQUE (tenant_id, project_id, generation, digest),
  FOREIGN KEY (tenant_id, project_id, digest, object_key, version_id)
    REFERENCES public.project_png_objects (tenant_id, project_id, digest, object_key, version_id)
    ON DELETE RESTRICT
);

CREATE INDEX project_png_generations_object
  ON public.project_png_generations (tenant_id, object_key, version_id);

CREATE TABLE public.project_png_heads (
  tenant_id text NOT NULL,
  project_id text NOT NULL,
  generation bigint NOT NULL,
  digest text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, project_id),
  FOREIGN KEY (tenant_id, project_id, generation, digest)
    REFERENCES public.project_png_generations (tenant_id, project_id, generation, digest) ON DELETE RESTRICT
);

CREATE TABLE public.project_png_deletions (
  tenant_id text NOT NULL,
  deletion_id uuid NOT NULL,
  project_id text NOT NULL,
  digest text NOT NULL CHECK (digest ~ '^[0-9a-f]{64}$'),
  object_key text NOT NULL CHECK (octet_length(object_key) BETWEEN 1 AND 1024),
  version_id text NOT NULL CHECK (octet_length(version_id) BETWEEN 1 AND 1024),
  etag text NOT NULL CHECK (octet_length(etag) BETWEEN 1 AND 512),
  byte_size integer NOT NULL CHECK (byte_size BETWEEN 1 AND 524288),
  queued_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  deleted_at timestamptz,
  PRIMARY KEY (tenant_id, deletion_id),
  UNIQUE (tenant_id, object_key, version_id),
  CHECK (
    object_key = 'tenants/' || tenant_id || '/projects/' || project_id || '/assets/image.png/' || digest
  )
);

CREATE INDEX project_png_deletions_tenant_queue
  ON public.project_png_deletions (tenant_id, queued_at, deletion_id)
  WHERE deleted_at IS NULL;

ALTER TABLE public.render_sessions
  ADD COLUMN project_png_generation bigint,
  ADD COLUMN project_png_digest text,
  ADD CONSTRAINT render_sessions_project_png_pair CHECK (
    (project_png_generation IS NULL) = (project_png_digest IS NULL)
    AND (project_png_generation IS NULL OR project_png_generation > 0)
    AND (project_png_digest IS NULL OR project_png_digest ~ '^[0-9a-f]{64}$')
  ),
  ADD CONSTRAINT render_sessions_project_png_fk
    FOREIGN KEY (tenant_id, project_id, project_png_generation, project_png_digest)
    REFERENCES public.project_png_generations (tenant_id, project_id, generation, digest)
    ON DELETE RESTRICT;
