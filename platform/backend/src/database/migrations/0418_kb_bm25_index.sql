-- drizzle-migration-linter: allow-breaking
-- drizzle-migration-linter: reason=the BM25 index cannot be built CONCURRENTLY inside a transactional migration, and it is only created where the optional pg_search extension is installed (opt-in deployments accepting the build lock on kb_chunks)

-- BM25 keyword ranking for knowledge-base search (issue #7158).
--
-- The ParadeDB pg_search extension is OPTIONAL: it is absent from managed
-- services (Cloud SQL, RDS, Azure), from the bundled Bitnami/Alpine Postgres
-- images, and from the PGlite test database. Extension creation therefore
-- degrades to a NOTICE instead of failing, mirroring 0116_pg_trgm_indexes.sql:
-- a deployment without pg_search completes this migration as a no-op and the
-- keyword lane keeps ranking with ts_rank (see knowledge-base/bm25-capability.ts).
-- Once pg_search is installed, an index-build error fails the migration rather
-- than recording an applied migration with no usable index.
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

-- The BM25 index folds the same text as search_vector into one field. Keeping
-- one combined field preserves matches whose terms span the contextual header,
-- content, and metadata. English stopwords and stemming mirror PostgreSQL's
-- english text-search configuration closely enough for the same AND-first
-- matching policy. The query path only routes all-English connector sets here;
-- other language configurations keep ts_rank.
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
        ((
          COALESCE(contextual_header, '') || ' ' ||
          content || ' ' ||
          COALESCE(metadata_suffix_keyword, '')
        )::pdb.simple(
          'alias=search_text',
          'stemmer=english',
          'stopwords_language=english'
        ))
      )
      WITH (key_field='id')
      -- Media chunks contain base64 data URLs and are vector-only retrieval
      -- inputs. Excluding them avoids indexing large opaque payloads.
      WHERE content NOT LIKE 'data:image/%';
    END IF;
  END IF;
END$$;
