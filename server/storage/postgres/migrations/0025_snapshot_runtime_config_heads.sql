LOCK TABLE
  public.snapshot_publications,
  public.snapshot_scene_heads
  IN ACCESS EXCLUSIVE MODE;

DELETE FROM public.snapshot_scene_heads
 WHERE publication_id IS NULL;

ALTER TABLE public.snapshot_scene_heads
  ADD COLUMN runtime_config_hash text;

UPDATE public.snapshot_scene_heads head
   SET runtime_config_hash = publication.runtime_config_hash
  FROM public.snapshot_publications publication
 WHERE publication.tenant_id = head.tenant_id
   AND publication.project_id = head.project_id
   AND publication.source_path = head.source_path
   AND publication.scene_name = head.scene_name
   AND publication.generation = head.generation
   AND publication.publication_id = head.publication_id
   AND publication.runtime_digest = head.runtime_digest;

ALTER TABLE public.snapshot_scene_heads
  DROP CONSTRAINT snapshot_scene_heads_runtime_publication_fkey,
  DROP CONSTRAINT snapshot_scene_heads_pkey;

ALTER TABLE public.snapshot_publications
  ADD CONSTRAINT snapshot_publications_runtime_config_identity UNIQUE
    (tenant_id, project_id, source_path, scene_name, generation, publication_id,
     runtime_digest, runtime_config_hash);

ALTER TABLE public.snapshot_scene_heads
  ALTER COLUMN runtime_config_hash SET NOT NULL,
  ADD CONSTRAINT snapshot_scene_heads_runtime_config_hash_check CHECK (
    runtime_config_hash ~ '^[0-9a-f]{64}$'
  ),
  ADD CONSTRAINT snapshot_scene_heads_pkey PRIMARY KEY
    (tenant_id, project_id, source_path, scene_name, runtime_digest, runtime_config_hash),
  ADD CONSTRAINT snapshot_scene_heads_runtime_config_publication_fkey FOREIGN KEY
    (tenant_id, project_id, source_path, scene_name, generation, publication_id,
     runtime_digest, runtime_config_hash)
    REFERENCES public.snapshot_publications
      (tenant_id, project_id, source_path, scene_name, generation, publication_id,
       runtime_digest, runtime_config_hash)
    ON DELETE RESTRICT;
