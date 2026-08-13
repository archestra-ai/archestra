-- drizzle-migration-linter: allow-breaking
-- drizzle-migration-linter: reason=the BM25 index cannot be built CONCURRENTLY inside a transactional migration, and it is only created where the optional pg_search extension is installed (opt-in deployments accepting the build lock on kb_chunks)

-- BM25 keyword ranking for knowledge-base search (issue #7158).
--
-- The ParadeDB pg_search extension is OPTIONAL: it is absent from managed
-- services (Cloud SQL, RDS, Azure), from the bundled Bitnami/Alpine Postgres
-- images, and from the PGlite test database. Both blocks below therefore
-- degrade to a NOTICE instead of failing, mirroring 0116_pg_trgm_indexes.sql:
-- a deployment without pg_search completes this migration as a no-op and the
-- keyword lane keeps ranking with ts_rank (see knowledge-base/bm25-capability.ts).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'pg_search') THEN
    -- CASCADE: pg_search >= 0.25 depends on pgvector, which is already
    -- installed on any knowledge-base deployment (0168).
    CREATE EXTENSION IF NOT EXISTS pg_search CASCADE;
  END IF;
EXCEPTION WHEN others THEN
  RAISE NOTICE 'pg_search extension not available, keyword search stays on ts_rank: %', SQLERRM;
END$$;

--> statement-breakpoint

-- The BM25 index over the same text the generated search_vector tsvector
-- folds: content, contextual header, keyword metadata suffix. Tokenizer note:
-- a pg_search index has ONE fixed tokenizer per field (no per-row
-- fts_language equivalent), so this index stems for the default corpus
-- language (English) and the query path only routes to BM25 when every
-- searched connector is English-configured; other languages keep ts_rank.
-- The index name must match KB_CHUNKS_BM25_INDEX in models/kb-chunk.ts —
-- the runtime probe looks it up by this literal.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_search') THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_class WHERE relname = 'kb_chunks_bm25_idx' AND relkind = 'i'
    ) THEN
      CREATE INDEX "kb_chunks_bm25_idx" ON "kb_chunks"
      USING bm25 (
        id,
        (content::pdb.simple('stemmer=english')),
        (contextual_header::pdb.simple('stemmer=english')),
        (metadata_suffix_keyword::pdb.simple('stemmer=english'))
      )
      WITH (key_field='id');
    END IF;
  END IF;
EXCEPTION WHEN others THEN
  RAISE NOTICE 'pg_search present but the BM25 index could not be created, keyword search stays on ts_rank: %', SQLERRM;
END$$;
