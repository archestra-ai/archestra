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
 * Rows that store their whole request are filled in chunks bounded by rows
 * and stored bytes. A delta-encoded row (Claude Code, Claude Desktop) stores
 * only the messages new since its parent, so its preview needs the request
 * folded from its ancestors; when one turns up, its whole thread is filled at
 * once, each row folded from its parent's fold, so the chain is loaded and
 * folded one time rather than once per row. Filling those rows chunk by chunk
 * held dozens of whole conversations at a time and exhausted the worker's
 * heap on sessions of hundreds of turns; a crashed worker then started over
 * from the same rows.
 *
 * Driven by the `interaction_session_preview_backfill` periodic task. Once
 * every row has a preview, a run is one empty read of a partial index that only
 * holds rows still to do (see `createInteractionsIndexes`).
 */
class InteractionSessionPreviewBackfill {
  /**
   * The last page every row of which has been tried. Kept across runs so rows
   * that cannot be filled are not retried before every batch; cleared at the
   * end of a pass, so the next pass retries them once.
   */
  private cursor: { createdAt: string; id: string } | null = null;

  /**
   * Threads left alone this pass because their stored requests exceed the
   * memory budget. Their rows keep turning up in later pages; remembering
   * them keeps each thread sized and reported once per pass.
   */
  private skippedThreads = new Set<string>();

  async run(
    params: { timeBudgetMs?: number; threadStoredBytesLimit?: number } = {},
  ): Promise<{ filled: number; failed: number; complete: boolean }> {
    const deadline = Date.now() + (params.timeBudgetMs ?? RUN_TIME_BUDGET_MS);
    const threadStoredBytesLimit =
      params.threadStoredBytesLimit ?? THREAD_MAX_STORED_BYTES;
    let filled = 0;
    let failed = 0;

    while (Date.now() < deadline) {
      const page = await InteractionModel.findRowsMissingSessionPreview({
        before: this.cursor,
        limit: PAGE_SIZE,
      });
      if (page.length === 0) {
        this.cursor = null;
        this.skippedThreads.clear();
        return { filled, failed, complete: true };
      }

      // The budget is checked between chunks and threads. A page cut short
      // keeps the cursor where it was: the next run reads the page again,
      // minus the rows filled meanwhile, and carries on. The cursor moves past
      // a page only once every row on it has been tried.
      let exhausted = false;
      const whole = page.filter(
        (row) => row.threadId === null || row.sessionId === null,
      );
      for (const ids of budgetedChunks(whole)) {
        if (Date.now() >= deadline) {
          exhausted = true;
          break;
        }
        const result = await fillChunk(ids);
        filled += result.filled;
        failed += result.failed;
      }

      const threads = new Map<string, ThreadOnPage>();
      for (const row of page) {
        if (row.threadId === null || row.sessionId === null) continue;
        const key = threadKey(row.sessionId, row.threadId);
        const thread = threads.get(key) ?? {
          sessionId: row.sessionId,
          threadId: row.threadId,
          pageRows: 0,
        };
        thread.pageRows += 1;
        threads.set(key, thread);
      }
      for (const [key, thread] of threads) {
        if (this.skippedThreads.has(key)) continue;
        if (exhausted || Date.now() >= deadline) {
          exhausted = true;
          break;
        }
        const result = await fillThread(thread, threadStoredBytesLimit);
        if (result.skipped) this.skippedThreads.add(key);
        filled += result.filled;
        failed += result.failed;
      }
      if (exhausted) break;

      const last = page[page.length - 1];
      this.cursor = { createdAt: last.createdAt, id: last.id };
    }

    return { filled, failed, complete: false };
  }
}

export const interactionSessionPreviewBackfill =
  new InteractionSessionPreviewBackfill();

// ===== Internal =====

/** Rows read per keyset page, before the byte budget subdivides them. */
const PAGE_SIZE = 200;

/** Whole-request rows filled per statement. */
const MAX_CHUNK_ROWS = 20;

/**
 * Stored request bytes of whole-request rows loaded at once. `pg_column_size`
 * reports the compressed size, and a request parsed from it takes several
 * times that, so this stays well below what the worker could hold. A single
 * row larger than this travels alone.
 */
const MAX_CHUNK_BYTES = 4 * 1024 * 1024;

/**
 * Stored request bytes (compressed) the rows a thread fill loads may hold.
 * Their suffixes are parsed and held while the rows are folded; a Claude Code
 * session of a thousand turns stays under this, and a thread above it is left
 * to the list's on-read fallback rather than risk the worker's heap.
 */
const THREAD_MAX_STORED_BYTES = 16 * 1024 * 1024;

/**
 * One run's share of the worker. Well under the task queue's five-minute stuck
 * timeout, and short enough that the system lane is not held for long.
 */
const RUN_TIME_BUDGET_MS = 45_000;

/** A delta-encoded thread with rows on the current page. */
interface ThreadOnPage {
  sessionId: string;
  threadId: string;
  pageRows: number;
}

function threadKey(sessionId: string, threadId: string): string {
  return `${sessionId}\u0000${threadId}`;
}

/**
 * Fill one chunk of whole-request rows. If the chunk fails, its rows are
 * retried one by one, so a single row that cannot be read (undecryptable
 * content, say) does not hold back the rest.
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
 * Fill one thread. A thread over the byte budget, or one whose fill fails as
 * a whole, is reported once and left to the list's on-read fallback. When the
 * fill throws, the thread's rows on the current page count as failed; how
 * many more it holds is unknown at that point.
 */
async function fillThread(
  thread: ThreadOnPage,
  storedBytesLimit: number,
): Promise<{ filled: number; failed: number; skipped: boolean }> {
  try {
    const result = await InteractionModel.fillThreadSessionPreviews({
      sessionId: thread.sessionId,
      threadId: thread.threadId,
      storedBytesLimit,
    });
    if (result.skipped) {
      logger.warn(
        {
          sessionId: thread.sessionId,
          threadId: thread.threadId,
          rows: result.failed,
          storedBytes: result.storedBytes,
          storedBytesLimit,
        },
        "Left a thread's session previews unfilled: its stored requests exceed the backfill's memory budget, so the session list keeps deriving them on read",
      );
    }
    return result;
  } catch (error) {
    logger.warn(
      { err: error, sessionId: thread.sessionId, threadId: thread.threadId },
      "Could not fill a thread's session previews; the session list keeps deriving them on read",
    );
    return { filled: 0, failed: thread.pageRows, skipped: true };
  }
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
