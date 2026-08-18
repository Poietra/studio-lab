-- Browser-rendered project thumbnails. This is deliberately separate from
-- render-session artifacts: the lineage root is the exact Editor Document,
-- and no source digest or synthetic render session is fabricated.

CREATE TABLE public.client_thumbnail_artifacts (
  tenant_id text NOT NULL,
  artifact_id uuid NOT NULL,
  content_digest text NOT NULL CHECK (content_digest ~ '^[0-9a-f]{64}$'),
  byte_size integer NOT NULL CHECK (byte_size BETWEEN 1 AND 4194304),
  object_key text NOT NULL CHECK (octet_length(object_key) BETWEEN 1 AND 1024),
  object_generation public.immutable_object_generation_v1 NOT NULL,
  etag text NOT NULL CHECK (octet_length(etag) BETWEEN 1 AND 512),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, artifact_id),
  UNIQUE (tenant_id, object_key, object_generation),
  FOREIGN KEY (tenant_id) REFERENCES public.workspace_tenants (tenant_id) ON DELETE RESTRICT,
  CHECK (
    object_key = 'tenants/' || tenant_id || '/client-thumbnails/image/'
      || content_digest || '/g/' || object_generation::text
  )
);

CREATE TABLE public.client_thumbnail_publications (
  tenant_id text NOT NULL,
  publication_id uuid NOT NULL,
  artifact_id uuid NOT NULL,
  project_id text NOT NULL,
  document_key bytea NOT NULL CHECK (octet_length(document_key) = 32),
  document_epoch uuid NOT NULL,
  document_revision bigint NOT NULL CHECK (document_revision >= 0),
  scene_contract_version integer NOT NULL CHECK (scene_contract_version = 1),
  scene_revision_hash text NOT NULL CHECK (scene_revision_hash ~ '^[0-9a-f]{64}$'),
  producer_kind text NOT NULL CHECK (producer_kind = 'browser-wasm-wgpu'),
  representative_frame_rule text NOT NULL CHECK (representative_frame_rule = 'last-representable-in-duration'),
  created_by_subject_id uuid NOT NULL,
  published_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, publication_id),
  UNIQUE (tenant_id, project_id, publication_id),
  UNIQUE (tenant_id, artifact_id),
  FOREIGN KEY (tenant_id, artifact_id)
    REFERENCES public.client_thumbnail_artifacts (tenant_id, artifact_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, project_id)
    REFERENCES public.workspace_projects (tenant_id, project_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, project_id, document_key, document_epoch)
    REFERENCES public.editor_documents (tenant_id, project_id, document_key, epoch) ON DELETE RESTRICT,
  FOREIGN KEY (created_by_subject_id) REFERENCES public.users (user_id) ON DELETE RESTRICT
);

-- One mutable pointer selects the launcher image. Publications and artifacts
-- remain immutable audit records; replaying an old publication never rewinds
-- this pointer.
CREATE TABLE public.workspace_project_client_thumbnail_heads (
  tenant_id text NOT NULL,
  project_id text NOT NULL,
  publication_id uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, project_id),
  FOREIGN KEY (tenant_id, project_id)
    REFERENCES public.workspace_projects (tenant_id, project_id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, project_id, publication_id)
    REFERENCES public.client_thumbnail_publications (tenant_id, project_id, publication_id) ON DELETE RESTRICT
);

CREATE FUNCTION public.reject_client_thumbnail_record_mutation_v33()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
BEGIN
  RAISE EXCEPTION 'An accepted client-thumbnail record is immutable.' USING ERRCODE = '23514';
END;
$function$;

CREATE TRIGGER client_thumbnail_artifacts_immutable
BEFORE UPDATE ON public.client_thumbnail_artifacts
FOR EACH ROW EXECUTE FUNCTION public.reject_client_thumbnail_record_mutation_v33();

CREATE TRIGGER client_thumbnail_publications_immutable
BEFORE UPDATE ON public.client_thumbnail_publications
FOR EACH ROW EXECUTE FUNCTION public.reject_client_thumbnail_record_mutation_v33();
