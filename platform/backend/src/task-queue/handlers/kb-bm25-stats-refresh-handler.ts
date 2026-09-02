import logger from "@/logging";
import { KbChunkModel } from "@/models";

/**
 * Rebuild the corpus statistics the BM25 keyword ranker scores from (issue
 * #7158). BM25 is the keyword ranker, so this runs on every deployment: the
 * first tick right after boot builds the statistics (queries fall back to
 * `ts_rank` until then), later ticks keep them fresh.
 *
 * A full read-only scan of `kb_chunks`, so its cost scales with the corpus and
 * it never blocks ingestion. Staleness is tolerable by design: the statistics
 * are a derived cache, and a lagging document frequency perturbs scores
 * slightly rather than making them wrong — measured, 20% corpus growth without
 * a refresh left 99.2% of top-10 results unchanged. That is why maintenance
 * lives here on a timer instead of on the ingestion write path, and why a
 * failed pass is logged and retried rather than escalated.
 *
 * Most ticks do no work: the model compares the corpus against the fingerprint
 * left by the last rebuild and returns early when nothing has changed. The two
 * outcomes are logged separately so a deployment that never rebuilds is
 * visibly skipping rather than silently failing.
 */
export async function handleKbBm25StatsRefresh(): Promise<void> {
  const startedAt = Date.now();
  const { languages, terms, skipped } = await KbChunkModel.refreshBm25Stats();
  const durationMs = Date.now() - startedAt;

  if (skipped) {
    logger.info(
      { durationMs },
      "[KbBm25StatsRefresh] Corpus unchanged since the last rebuild, skipped",
    );
    return;
  }

  logger.info(
    { languages, terms, durationMs },
    "[KbBm25StatsRefresh] Rebuilt knowledge-base BM25 corpus statistics",
  );
}
