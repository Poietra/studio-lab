-- Client-export publication per ADR 0005 "Artifact lineage and publication".
-- A client-produced MP4 becomes an immutable artifact, its Editor Document
-- lineage, and one durable publication in a single acceptance transaction.
-- The schema is deliberately narrow: no generic artifact framework, no
-- upload-session aggregate, no export head or generation, and no foreign key
-- to editor_edit_events because revision zero is a valid exported document
-- state that has no event row.

-- Immutable client-export video bytes plus their private object receipt. The
-- persisted locator column reuses the immutable-object compatibility spelling
-- and domain from migration v20; the internal contract vocabulary for this
-- random UUID locator nonce is objectLocatorToken (it is not a monotonic
-- generation). The object key embeds the token, so one uploaded byte identity
-- may exist under many locators while each locator names exactly one object.
CREATE TABLE public.client_export_artifacts (
  tenant_id text NOT NULL,
  artifact_id uuid NOT NULL,
  artifact_kind text NOT NULL CHECK (artifact_kind = 'video'),
  media_type text NOT NULL CHECK (media_type = 'video/mp4'),
  content_digest text NOT NULL CHECK (content_digest ~ '^[0-9a-f]{64}$'),
  byte_size integer NOT NULL CHECK (byte_size BETWEEN 1 AND 134217728),
  object_key text NOT NULL CHECK (octet_length(object_key) BETWEEN 1 AND 1024),
  object_generation public.immutable_object_generation_v1 NOT NULL,
  etag text NOT NULL CHECK (octet_length(etag) BETWEEN 1 AND 512),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, artifact_id),
  UNIQUE (tenant_id, object_key, object_generation),
  FOREIGN KEY (tenant_id) REFERENCES public.workspace_tenants (tenant_id) ON DELETE RESTRICT,
  CONSTRAINT client_export_artifacts_immutable_key_v31 CHECK (
    object_key = 'tenants/' || tenant_id || '/client-exports/' || artifact_kind
      || '/' || content_digest || '/g/' || object_generation::text
  )
);

-- One durable publication per accepted artifact, carrying its lineage columns
-- directly. publication_id alone is the idempotency identity: a replay with
-- the same complete immutable payload returns the existing success and any
-- differing field is a conflict, which the repository decides by comparing
-- this row before settling any quota. The document foreign key anchors the
-- lineage to the exact Editor Document identity; the recorded revision is
-- validated against the locked document row in the acceptance transaction.
CREATE TABLE public.client_export_publications (
  tenant_id text NOT NULL,
  publication_id uuid NOT NULL,
  artifact_id uuid NOT NULL,
  project_id text NOT NULL,
  document_key bytea NOT NULL CHECK (octet_length(document_key) = 32),
  document_epoch uuid NOT NULL,
  document_revision bigint NOT NULL CHECK (document_revision >= 0),
  scene_contract_version integer NOT NULL CHECK (scene_contract_version = 1),
  scene_revision_hash text NOT NULL CHECK (scene_revision_hash ~ '^[0-9a-f]{64}$'),
  export_profile_hash text NOT NULL CHECK (export_profile_hash ~ '^[0-9a-f]{64}$'),
  producer_kind text NOT NULL CHECK (producer_kind = 'browser-webcodecs'),
  encoder_evidence_version integer NOT NULL CHECK (encoder_evidence_version = 1),
  encoder_evidence json NOT NULL CHECK (
    json_typeof(encoder_evidence) = 'object'
    AND octet_length(encoder_evidence::text) <= 16384
  ),
  created_by_subject_id uuid NOT NULL,
  published_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, publication_id),
  UNIQUE (tenant_id, artifact_id),
  CONSTRAINT client_export_publications_artifact_fkey_v31
    FOREIGN KEY (tenant_id, artifact_id)
    REFERENCES public.client_export_artifacts (tenant_id, artifact_id)
    ON DELETE RESTRICT,
  CONSTRAINT client_export_publications_project_fkey_v31
    FOREIGN KEY (tenant_id, project_id)
    REFERENCES public.workspace_projects (tenant_id, project_id)
    ON DELETE RESTRICT,
  CONSTRAINT client_export_publications_document_fkey_v31
    FOREIGN KEY (tenant_id, project_id, document_key, document_epoch)
    REFERENCES public.editor_documents (tenant_id, project_id, document_key, epoch)
    ON DELETE RESTRICT,
  CONSTRAINT client_export_publications_subject_fkey_v31
    FOREIGN KEY (created_by_subject_id)
    REFERENCES public.users (user_id)
    ON DELETE RESTRICT,
  CONSTRAINT client_export_publications_expiry_v31 CHECK (expires_at > published_at)
);

CREATE INDEX client_export_publications_expiry_scan_v31
  ON public.client_export_publications (tenant_id, expires_at);

-- A read claim is a short-lived pin that keeps immutable bytes readable while
-- an authenticated stream is open. It is not a lease and grants no write
-- ownership; expiry GC queues physical deletion only when no live claim pins
-- the artifact.
CREATE TABLE public.client_export_read_claims (
  tenant_id text NOT NULL,
  claim_id uuid NOT NULL,
  artifact_id uuid NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, claim_id),
  FOREIGN KEY (tenant_id, artifact_id)
    REFERENCES public.client_export_artifacts (tenant_id, artifact_id)
    ON DELETE CASCADE,
  CHECK (expires_at > created_at)
);

CREATE INDEX client_export_live_claims_v31
  ON public.client_export_read_claims (tenant_id, artifact_id, expires_at);

-- One queue/tombstone row per collected artifact, copying the exact object
-- receipt so the deletion worker removes only that receipt and records its
-- acknowledgement without resurrecting a later object under the same key.
-- The tombstone deliberately has no tenant foreign key: it must outlive the
-- rows it buries.
CREATE TABLE public.client_export_deletions (
  tenant_id text NOT NULL,
  deletion_id uuid NOT NULL,
  content_digest text NOT NULL CHECK (content_digest ~ '^[0-9a-f]{64}$'),
  byte_size integer NOT NULL CHECK (byte_size BETWEEN 1 AND 134217728),
  object_key text NOT NULL CHECK (octet_length(object_key) BETWEEN 1 AND 1024),
  object_generation public.immutable_object_generation_v1 NOT NULL,
  etag text NOT NULL CHECK (octet_length(etag) BETWEEN 1 AND 512),
  queued_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  deleted_at timestamptz,
  PRIMARY KEY (tenant_id, deletion_id),
  UNIQUE (tenant_id, object_key, object_generation),
  CONSTRAINT client_export_deletions_immutable_key_v31 CHECK (
    object_key = 'tenants/' || tenant_id || '/client-exports/video/'
      || content_digest || '/g/' || object_generation::text
  )
);

CREATE INDEX client_export_pending_deletion_queue_v31
  ON public.client_export_deletions (tenant_id, queued_at, deletion_id)
  WHERE deleted_at IS NULL;

-- Accepted artifacts and publications are immutable records. Expiry GC may
-- delete them (publication first, then artifact) after queueing the tombstone,
-- but no accepted field is ever rewritten in place.
CREATE FUNCTION public.reject_client_export_mutation_v31()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
BEGIN
  RAISE EXCEPTION 'An accepted client-export record is immutable.' USING ERRCODE = '23514';
END;
$function$;

CREATE TRIGGER client_export_artifacts_immutable
BEFORE UPDATE ON public.client_export_artifacts
FOR EACH ROW
EXECUTE FUNCTION public.reject_client_export_mutation_v31();

CREATE TRIGGER client_export_publications_immutable
BEFORE UPDATE ON public.client_export_publications
FOR EACH ROW
EXECUTE FUNCTION public.reject_client_export_mutation_v31();
