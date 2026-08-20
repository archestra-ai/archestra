import {
  bigint,
  numeric,
  pgTable,
  primaryKey,
  text,
} from "drizzle-orm/pg-core";

/**
 * Corpus statistics for the portable BM25 keyword ranker (issue #7158).
 *
 * BM25 needs three things PostgreSQL's `ts_rank` never computes: how many
 * chunks contain a term (`df`), how many chunks exist (`n_docs`), and how long
 * the average chunk is (`avg_dl`). None of them can be derived from a single
 * row, which is why `ts_rank` cannot express BM25 at any setting.
 *
 * All three are recoverable from what the corpus already stores — `ts_stat()`
 * returns document frequency per lexeme, and a `tsvector`'s positions give
 * term frequency and token length — so this ranker needs NO new index on
 * `kb_chunks`. It reuses `kb_chunks_search_vector_idx` (the GIN index) for
 * recall and scores the candidates it returns. That is what makes it portable:
 * it runs on stock PostgreSQL, including managed services where the ParadeDB
 * `pg_search` extension cannot be installed at all.
 *
 * These tables are a derived cache, never a source of truth. They are rebuilt
 * by the `kb_bm25_stats_refresh` periodic task and may lag the corpus; stale
 * statistics perturb scores slightly rather than making them wrong (measured:
 * 20% corpus growth without a refresh left 99.2% of top-10 results unchanged),
 * so nothing writes to them on the ingestion hot path.
 */

/**
 * Document frequency per lexeme, keyed by text-search configuration.
 *
 * Keyed by language because `kb_chunks.search_vector` is generated with each
 * chunk's own `fts_language`: a German chunk stores German stems. Pooling
 * stems from different configurations into one count would compute document
 * frequency over a corpus that does not exist, and IDF with it.
 *
 * `ftsLanguage` is `text` here, not the `regconfig` used on `kb_chunks`.
 * `regconfig` is an OID reference to a catalog entry, and these rows outlive
 * any one query's configuration set; storing the name keeps the table
 * dump/restore-safe. Comparisons against `kb_chunks.fts_language` must cast
 * explicitly — PostgreSQL will not coerce `regconfig` to `text` on its own.
 */
export const kbBm25TermStatsTable = pgTable(
  "kb_bm25_term_stats",
  {
    ftsLanguage: text("fts_language").notNull(),
    term: text("term").notNull(),
    df: bigint("df", { mode: "number" }).notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.ftsLanguage, table.term],
      name: "kb_bm25_term_stats_pkey",
    }),
  ],
);

/**
 * Per-language corpus totals: chunk count and mean chunk length in tokens.
 *
 * `avgDl` is `numeric` rather than a float because it divides the
 * length-normalization term of every score; a drifting binary float would make
 * ranking depend on the order rows were aggregated in.
 */
export const kbBm25CorpusStatsTable = pgTable("kb_bm25_corpus_stats", {
  ftsLanguage: text("fts_language").primaryKey(),
  nDocs: bigint("n_docs", { mode: "number" }).notNull(),
  avgDl: numeric("avg_dl").notNull(),
});
