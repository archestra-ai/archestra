-- drizzle-migration-linter: allow-breaking
-- drizzle-migration-linter: reason=tok_len is a STORED generated column, so adding it rewrites kb_chunks and holds ACCESS EXCLUSIVE for the duration — the same operation, on the same table, that 0404 already performs and documents. It cannot be added non-generated and backfilled in this migration instead, because the ranker needs the value to stay correct as chunks change and a plain column would silently rot. ACCESS EXCLUSIVE blocks READS as well as writes: for the length of the rewrite every knowledge-base search and every RAG-backed chat turn waits on this lock, so on a large corpus this is a maintenance window, not a background migration — measure kb_chunks and schedule accordingly. No index is created here: the portable BM25 ranker reuses the existing kb_chunks_search_vector_idx GIN index for recall.

-- Portable BM25 keyword ranking (issue #7158), the stock-PostgreSQL half of
-- T-1039. Unlike the ParadeDB pg_search prototype it needs no extension and no
-- new index on kb_chunks: BM25's inputs are all recoverable from what the
-- corpus already stores.
--
--   f(t,D) term frequency  -> the position array a tsvector keeps per lexeme
--   |D|    chunk length    -> tok_len, below
--   df/N/avgdl             -> kb_bm25_term_stats + kb_bm25_corpus_stats
--
-- Total tokens in a tsvector. NOT length(tsvector), which counts distinct
-- lexemes — BM25's length normalization needs total occurrences, so this sums
-- the position arrays. A lexeme carrying no positions (possible in a tsvector
-- built by strip()) counts once rather than zero.
--
-- IMMUTABLE is required for use in a generated column and is honest here: the
-- result depends only on the input value. PARALLEL SAFE lets the corpus-stats
-- refresh scan use parallel workers.
CREATE OR REPLACE FUNCTION tsv_token_count(tsvector)
RETURNS integer
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
STRICT
AS $$
  SELECT COALESCE(sum(COALESCE(array_length(positions, 1), 1)), 0)::integer
  FROM unnest($1)
$$;--> statement-breakpoint

-- Corpus totals per configuration: chunk count (N) and mean chunk length
-- (avgdl), two of BM25's inputs that cannot come from a single row. Rebuilt
-- by the kb_bm25_stats_refresh periodic task.
CREATE TABLE "kb_bm25_corpus_stats" (
	"fts_language" text PRIMARY KEY NOT NULL,
	"n_docs" bigint NOT NULL,
	"avg_dl" numeric NOT NULL
);
--> statement-breakpoint

-- Document frequency per lexeme, per text-search configuration.
--
-- Keyed by language because search_vector is generated with each chunk's own
-- fts_language: a German chunk stores German stems. Counting stems from
-- different configurations together would compute IDF over a corpus that does
-- not exist.
CREATE TABLE "kb_bm25_term_stats" (
	"fts_language" text NOT NULL,
	"term" text NOT NULL,
	"df" bigint NOT NULL,
	CONSTRAINT "kb_bm25_term_stats_pkey" PRIMARY KEY("fts_language","term")
);
--> statement-breakpoint

-- Mirrors 0404's search_vector expression exactly, and must keep mirroring it:
-- the two describe the same text, and BM25's length normalization is wrong the
-- moment they disagree. The expression is repeated rather than referenced
-- because PostgreSQL forbids a generated column from reading another generated
-- column.
ALTER TABLE "kb_chunks" ADD COLUMN "tok_len" integer GENERATED ALWAYS AS (
  tsv_token_count(
    to_tsvector(
      fts_language,
      COALESCE(contextual_header, '') || ' ' || content || ' ' || COALESCE(metadata_suffix_keyword, '')
    )
  )
) STORED;--> statement-breakpoint

-- The organization's BM25 tuning overrides (Settings > Knowledge > Search
-- Ranking Configuration). NULL = follow the deployment default from
-- ARCHESTRA_KNOWLEDGE_BASE_BM25_K1 / _B.
ALTER TABLE "organization" ADD COLUMN "kb_bm25_k1" double precision;--> statement-breakpoint
ALTER TABLE "organization" ADD COLUMN "kb_bm25_b" double precision;
