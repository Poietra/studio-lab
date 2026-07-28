CREATE TABLE public.render_sessions (
  tenant_id text NOT NULL,
  session_id uuid NOT NULL,
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
  scene_name text NOT NULL CHECK (scene_name ~ '^[A-Za-z_][A-Za-z0-9_]*$' AND char_length(scene_name) <= 128),
  program_batch_id text NOT NULL CHECK (char_length(program_batch_id) BETWEEN 1 AND 240),
  program_transaction_id text NOT NULL CHECK (char_length(program_transaction_id) BETWEEN 1 AND 240),
  render_request_id text NOT NULL CHECK (char_length(render_request_id) BETWEEN 1 AND 240),
  commit_correlation_key text NOT NULL CHECK (octet_length(commit_correlation_key) BETWEEN 1 AND 2048),
  original_generation bigint NOT NULL CHECK (original_generation > 0),
  original_digest text NOT NULL,
  patched_digest text NOT NULL,
  patch_anchor_line integer NOT NULL CHECK (patch_anchor_line > 0),
  patch_anchor_lines integer[] NOT NULL CHECK (
    cardinality(patch_anchor_lines) BETWEEN 1 AND 128
    AND 0 < ALL (patch_anchor_lines)
  ),
  patch_inserted_code text NOT NULL CHECK (octet_length(patch_inserted_code) <= 2097152),
  status text NOT NULL CHECK (
    status IN ('cancelled', 'committed', 'discarded', 'failed', 'preparing', 'ready', 'rendering', 'undone')
  ),
  execution_attempts integer NOT NULL DEFAULT 0 CHECK (execution_attempts >= 0),
  execution_deadline timestamptz NOT NULL,
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  fence_token bigint NOT NULL DEFAULT 0 CHECK (fence_token >= 0),
  lease_owner text CHECK (lease_owner IS NULL OR char_length(lease_owner) BETWEEN 1 AND 240),
  lease_expires_at timestamptz,
  progress double precision NOT NULL DEFAULT 0.1 CHECK (progress >= 0 AND progress <= 1),
  log_tail text NOT NULL DEFAULT '' CHECK (octet_length(log_tail) <= 65536),
  error text CHECK (error IS NULL OR octet_length(error) <= 4096),
  artifact_locator text CHECK (artifact_locator IS NULL OR octet_length(artifact_locator) <= 2048),
  latest_action_id uuid,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, session_id),
  FOREIGN KEY (tenant_id, project_id)
    REFERENCES public.workspace_projects (tenant_id, project_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, original_digest)
    REFERENCES public.source_blob_objects (tenant_id, digest) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, patched_digest)
    REFERENCES public.source_blob_objects (tenant_id, digest) ON DELETE RESTRICT,
  CHECK ((lease_owner IS NULL) = (lease_expires_at IS NULL))
);

CREATE INDEX render_sessions_recovery_queue
  ON public.render_sessions (tenant_id, updated_at, session_id)
  WHERE status IN ('preparing', 'rendering');

CREATE TABLE public.render_source_actions (
  tenant_id text NOT NULL,
  action_id uuid NOT NULL,
  session_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('commit', 'undo')),
  expected_key text CHECK (expected_key IS NULL OR octet_length(expected_key) BETWEEN 1 AND 2048),
  state text NOT NULL CHECK (state IN ('cancelled', 'failed', 'running', 'succeeded')),
  outcome text CHECK (outcome IN ('committed', 'undone')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, action_id),
  UNIQUE (tenant_id, session_id, action_id),
  FOREIGN KEY (tenant_id, session_id)
    REFERENCES public.render_sessions (tenant_id, session_id) ON DELETE CASCADE,
  CHECK (
    (state = 'succeeded' AND outcome = CASE kind WHEN 'commit' THEN 'committed' ELSE 'undone' END)
    OR (state <> 'succeeded' AND outcome IS NULL)
  )
);

ALTER TABLE public.render_sessions
  ADD CONSTRAINT render_sessions_latest_action_fk
  FOREIGN KEY (tenant_id, session_id, latest_action_id)
  REFERENCES public.render_source_actions (tenant_id, session_id, action_id)
  DEFERRABLE INITIALLY DEFERRED;
