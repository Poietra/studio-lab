-- Editor documents gain an explicit closed origin per ADR 0005. Adding the
-- column with a default backfills every pre-cutover row as the imported Manim
-- compatibility lane under the access-exclusive lock held until this migration
-- commits, so no writer can race the cutover and no row is ever observed
-- without an origin.
ALTER TABLE public.editor_documents
  ADD COLUMN origin text NOT NULL DEFAULT 'imported-manim',
  ADD CONSTRAINT editor_documents_origin_closed_v30
    CHECK (origin IN ('studio-native', 'imported-manim'));

-- Source binding becomes an origin property instead of part of every
-- document's identity. Only the imported lane carries a Python source path and
-- exact source digest; a Studio-native document must carry neither. The v17
-- per-column shape checks continue to validate any present value, so an
-- imported binding stays exactly as strict as before. Together with the v17
-- identity-immutability trigger, which freezes source_path and source_hash for
-- the life of an epoch, this constraint pair also makes the origin itself
-- immutable: neither lane can flip without violating one of them.
ALTER TABLE public.editor_documents
  ALTER COLUMN source_path DROP NOT NULL,
  ALTER COLUMN source_hash DROP NOT NULL,
  ADD CONSTRAINT editor_documents_origin_source_binding_v30 CHECK (
    (origin = 'imported-manim' AND source_path IS NOT NULL AND source_hash IS NOT NULL)
    OR (origin = 'studio-native' AND source_path IS NULL AND source_hash IS NULL)
  );

-- Existing rows keep their backfilled imported origin. Removing the default
-- makes every post-cutover writer name the document origin explicitly; an old
-- pre-v30 binary now fails closed instead of minting a document in an
-- ambiguous lane.
ALTER TABLE public.editor_documents
  ALTER COLUMN origin DROP DEFAULT;

-- The v17 epoch and revision-CAS/seal triggers, the v17 open-document partial
-- unique index, and the v18/v23 event and projection invariants are
-- key-shape-agnostic and continue to apply unchanged to both origins.
