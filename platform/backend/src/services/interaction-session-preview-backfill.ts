import logger from "@/logging";
import InteractionModel from "@/models/interaction";

/**
 * Fills `session_preview` on interactions written before migration 0562 added
 * it.
 *
 * The session list reads a preview for the newest and oldest turns of every
 * session on the page. A row without one makes the list load the row's whole
 * request, decrypt it, rebuild it from its delta chain and stringify it. On a
 * deployment with a long history that is most rows. One page of 100 sessions
 * can then hold hundreds of multi-megabyte requests in memory, and a client
 * that pages through every session pays that for every page. Filling the
 * column moves that work to the worker, once per row.
 *
 * Newest rows first, so the sessions people and polling clients read most stop
 * paying soonest. Each run is bounded by time and picks up where the last one
 * stopped. The fill never overwrites a preview, so overlapping runs, or a run
 * racing a new write, are harmless.
 *
 * Driven by the `interaction_session_preview_backfill` periodic task. Once
 * every row has a preview, a run is one empty read of a partial index that only
 * holds rows still to do (see `createInteractionsIndexes`).
 */
class InteractionSessionPreviewBackfill {
  /**
   * Where the last run stopped. Kept across runs so rows that cannot be filled
   * are not retried before every batch; cleared at the end of a pass, so the
   * next pass retries them once.
   */
  private cursor: { createdAt: string; id: string } | null = null;

  async run(
    params: { timeBudgetMs?: number } = {},
  ): Promise<{ filled: number; failed: number; complete: boolean }> {
    const deadline = Date.now() + (params.timeBudgetMs ?? RUN_TIME_BUDGET_MS);
    let filled = 0;
    let failed = 0;

    while (Date.now() < deadline) {
      const page = await InteractionModel.findRowsMissingSessionPreview({
        before: this.cursor,
        limit: PAGE_SIZE,
      });
      if (page.length === 0) {
        this.cursor = null;
        return { filled, failed, complete: true };
      }
      const last = page[page.length - 1];
      this.cursor = { createdAt: last.createdAt, id: last.id };

      for (const ids of budgetedChunks(page)) {
        const result = await fillChunk(ids);
        filled += result.filled;
        failed += result.failed;
      }
    }

    return { filled, failed, complete: false };
  }
}

export const interactionSessionPreviewBackfill =
  new InteractionSessionPreviewBackfill();

// ===== Internal =====

/** Rows read per keyset page, before the byte budget subdivides them. */
const PAGE_SIZE = 200;

/** Rows filled per statement. */
const MAX_CHUNK_ROWS = 50;

/**
 * Stored request bytes loaded at once. Claude Code requests run to several
 * megabytes, and the worker is memory-capped. A delta-encoded row also loads
 * its ancestors, which a stored size cannot predict, so this stays well below
 * what the worker could hold. A single row larger than this travels alone.
 */
const MAX_CHUNK_BYTES = 16 * 1024 * 1024;

/**
 * One run's share of the worker. Well under the task queue's five-minute stuck
 * timeout, and short enough that the system lane is not held for long.
 */
const RUN_TIME_BUDGET_MS = 45_000;

/**
 * Fill one chunk. If the chunk fails, its rows are retried one by one, so a
 * single row that cannot be read (undecryptable content, say) does not hold
 * back the rest.
 */
async function fillChunk(
  ids: string[],
): Promise<{ filled: number; failed: number }> {
  try {
    return {
      filled: await InteractionModel.fillSessionPreviews(ids),
      failed: 0,
    };
  } catch (error) {
    if (ids.length === 1) {
      logger.warn(
        { err: error, interactionId: ids[0] },
        "Could not fill the session preview of an interaction; the session list keeps deriving it on read",
      );
      return { filled: 0, failed: 1 };
    }
  }

  let filled = 0;
  let failed = 0;
  for (const id of ids) {
    const result = await fillChunk([id]);
    filled += result.filled;
    failed += result.failed;
  }
  return { filled, failed };
}

/**
 * Cut a sized page into id chunks that fit {@link MAX_CHUNK_BYTES} and
 * {@link MAX_CHUNK_ROWS}. A row larger than the byte budget is yielded alone
 * rather than skipped.
 */
function* budgetedChunks(
  rows: Array<{ id: string; requestBytes: number }>,
): Generator<string[]> {
  let chunk: string[] = [];
  let bytes = 0;

  for (const row of rows) {
    if (
      chunk.length > 0 &&
      (bytes + row.requestBytes > MAX_CHUNK_BYTES ||
        chunk.length >= MAX_CHUNK_ROWS)
    ) {
      yield chunk;
      chunk = [];
      bytes = 0;
    }
    chunk.push(row.id);
    bytes += row.requestBytes;
  }

  if (chunk.length > 0) yield chunk;
}
