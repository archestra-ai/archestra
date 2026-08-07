ALTER TABLE "kb_chunks" ADD COLUMN "contextual_header" text;--> statement-breakpoint
ALTER TABLE "kb_chunks" ADD COLUMN "fts_language" "regconfig" DEFAULT 'english' NOT NULL;--> statement-breakpoint
ALTER TABLE "knowledge_base_connectors" ADD COLUMN "fts_language" text DEFAULT 'english' NOT NULL;--> statement-breakpoint
-- Rebuild the generated search_vector so the keyword index (a) covers the
-- document-level contextual header and (b) stems with the chunk's own
-- text-search configuration instead of a hardcoded 'english'.
--
-- A generated column's expression cannot be altered in place, so this is a
-- drop + re-add, which rewrites kb_chunks and rebuilds its GIN index.
--
-- `fts_language` is typed `regconfig` rather than `text` precisely so this
-- expression stays IMMUTABLE: to_tsvector(regconfig, text) is immutable, while
-- a text::regconfig cast is only STABLE and PostgreSQL would reject it here.
--
-- Existing rows are unaffected in meaning: contextual_header is NULL and
-- fts_language defaults to 'english', so the recomputed tsvector matches what
-- the previous expression produced.
ALTER TABLE "kb_chunks" DROP COLUMN "search_vector";--> statement-breakpoint
ALTER TABLE "kb_chunks" ADD COLUMN "search_vector" tsvector GENERATED ALWAYS AS (
  to_tsvector(
    fts_language,
    COALESCE(contextual_header, '') || ' ' || content || ' ' || COALESCE(metadata_suffix_keyword, '')
  )
) STORED;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "kb_chunks_search_vector_idx" ON "kb_chunks" USING gin ("search_vector");
