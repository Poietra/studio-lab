CREATE TABLE public.render_artifact_objects (
  tenant_id text NOT NULL,
  artifact_id uuid NOT NULL,
  artifact_kind text NOT NULL CHECK (artifact_kind IN ('thumbnail', 'video')),
  media_type text NOT NULL CHECK (
    (artifact_kind = 'thumbnail' AND media_type = 'image/png')
    OR (artifact_kind = 'video' AND media_type = 'video/mp4')
  ),
  artifact_digest text NOT NULL CHECK (artifact_digest ~ '^[0-9a-f]{64}$'),
  source_digest text NOT NULL CHECK (source_digest ~ '^[0-9a-f]{64}$'),
  runtime_digest text NOT NULL CHECK (runtime_digest ~ '^[0-9a-f]{64}$'),
  profile_digest text NOT NULL CHECK (profile_digest ~ '^[0-9a-f]{64}$'),
  request_digest text NOT NULL CHECK (request_digest ~ '^[0-9a-f]{64}$'),
  object_key text NOT NULL CHECK (octet_length(object_key) BETWEEN 1 AND 1024),
  version_id text NOT NULL CHECK (octet_length(version_id) BETWEEN 1 AND 1024),
  etag text NOT NULL CHECK (octet_length(etag) BETWEEN 1 AND 512),
  byte_size integer NOT NULL CHECK (
    (artifact_kind = 'thumbnail' AND byte_size BETWEEN 1 AND 4194304)
    OR (artifact_kind = 'video' AND byte_size BETWEEN 1 AND 134217728)
  ),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, artifact_id),
  UNIQUE (tenant_id, object_key, version_id),
  FOREIGN KEY (tenant_id, source_digest)
    REFERENCES public.source_blob_objects (tenant_id, digest) ON DELETE RESTRICT,
  CHECK (expires_at > created_at)
);

CREATE INDEX render_artifact_expiry_queue
  ON public.render_artifact_objects (tenant_id, expires_at, artifact_id);

CREATE TABLE public.render_session_artifacts (
  tenant_id text NOT NULL,
  session_id uuid NOT NULL,
  artifact_kind text NOT NULL CHECK (artifact_kind IN ('thumbnail', 'video')),
  artifact_id uuid NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, session_id, artifact_kind),
  FOREIGN KEY (tenant_id, session_id)
    REFERENCES public.render_sessions (tenant_id, session_id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, artifact_id)
    REFERENCES public.render_artifact_objects (tenant_id, artifact_id) ON DELETE RESTRICT,
  CHECK (expires_at > created_at)
);

CREATE TABLE public.workspace_project_thumbnail_heads (
  tenant_id text NOT NULL,
  project_id text NOT NULL,
  session_id uuid NOT NULL,
  artifact_id uuid NOT NULL,
  session_created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, project_id),
  FOREIGN KEY (tenant_id, project_id)
    REFERENCES public.workspace_projects (tenant_id, project_id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, session_id)
    REFERENCES public.render_sessions (tenant_id, session_id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, artifact_id)
    REFERENCES public.render_artifact_objects (tenant_id, artifact_id) ON DELETE RESTRICT,
  CHECK (expires_at > session_created_at)
);

CREATE TABLE public.render_artifact_read_claims (
  tenant_id text NOT NULL,
  claim_id uuid NOT NULL,
  artifact_id uuid NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, claim_id),
  FOREIGN KEY (tenant_id, artifact_id)
    REFERENCES public.render_artifact_objects (tenant_id, artifact_id) ON DELETE CASCADE,
  CHECK (expires_at > created_at)
);

CREATE INDEX render_artifact_live_claims
  ON public.render_artifact_read_claims (tenant_id, artifact_id, expires_at);

CREATE TABLE public.render_artifact_deletions (
  tenant_id text NOT NULL,
  deletion_id uuid NOT NULL,
  artifact_kind text NOT NULL CHECK (artifact_kind IN ('thumbnail', 'video')),
  media_type text NOT NULL CHECK (
    (artifact_kind = 'thumbnail' AND media_type = 'image/png')
    OR (artifact_kind = 'video' AND media_type = 'video/mp4')
  ),
  artifact_digest text NOT NULL CHECK (artifact_digest ~ '^[0-9a-f]{64}$'),
  source_digest text NOT NULL CHECK (source_digest ~ '^[0-9a-f]{64}$'),
  runtime_digest text NOT NULL CHECK (runtime_digest ~ '^[0-9a-f]{64}$'),
  profile_digest text NOT NULL CHECK (profile_digest ~ '^[0-9a-f]{64}$'),
  request_digest text NOT NULL CHECK (request_digest ~ '^[0-9a-f]{64}$'),
  object_key text NOT NULL CHECK (octet_length(object_key) BETWEEN 1 AND 1024),
  version_id text NOT NULL CHECK (octet_length(version_id) BETWEEN 1 AND 1024),
  etag text NOT NULL CHECK (octet_length(etag) BETWEEN 1 AND 512),
  byte_size integer NOT NULL CHECK (
    (artifact_kind = 'thumbnail' AND byte_size BETWEEN 1 AND 4194304)
    OR (artifact_kind = 'video' AND byte_size BETWEEN 1 AND 134217728)
  ),
  queued_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, deletion_id),
  UNIQUE (tenant_id, object_key, version_id)
);

CREATE INDEX render_artifact_deletion_queue
  ON public.render_artifact_deletions (tenant_id, queued_at, deletion_id);
