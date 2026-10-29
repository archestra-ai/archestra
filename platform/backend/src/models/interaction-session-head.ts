import { and, eq, type SQL, sql } from "drizzle-orm";
import db, { schema, withDbTransaction } from "@/database";
import logger from "@/logging";
import { registerProcessLocalCache } from "@/process-local-cache-registry";

/**
 * The stored head of every session (see `interaction_session_heads`): the
 * newest interaction of each session, maintained by triggers on
 * `interactions`. Reading a page of sessions from it is one index-ordered
 * scan whose cost depends on the page, not on how many rows the sessions
 * above the cursor hold.
 */
class InteractionSessionHeadModel {
  /**
   * Whether every interaction is reflected in the head table. Until the
   * startup backfill finishes, rows that predate the table are missing from
   * it, so callers must keep reading heads from `interactions`.
   *
   * Completion is permanent — nothing re-creates the marker — so once seen
   * it is remembered for the life of the process.
   */
  static async isComplete(): Promise<boolean> {
    if (completion.complete) return true;
    const [marker] = await db
      .select({ id: schema.interactionSessionHeadsBackfillTable.id })
      .from(schema.interactionSessionHeadsBackfillTable)
      .limit(1);
    if (!marker) completion.complete = true;
    return completion.complete;
  }

  /**
   * The heads of one page, newest first, with `(createdAt, id)` strictly
   * below `before` when given. Fetches `limit + 1` so the caller can tell
   * whether another page exists.
   *
   * `interactionFilter` is applied to the head interaction itself, joined by
   * primary key: a session is listed when its newest row passes the filter,
   * the same rule the interactions scan applies. `userId` and `sessionKey`
   * repeat filters already inside `interactionFilter` against the head
   * table's own columns, so the scan can start from the matching index entry
   * instead of skipping over other users' sessions.
   */
  static async findPage(params: {
    interactionFilter: SQL | undefined;
    userId?: string;
    sessionKey?: string;
    before: { createdAt: string; id: string } | null;
    limit: number;
  }): Promise<
    Array<{ sessionId: string | null; headCreatedAt: Date; headId: string }>
  > {
    const head = schema.interactionSessionHeadsTable;
    const interaction = schema.interactionsTable;
    const conditions: (SQL | undefined)[] = [params.interactionFilter];
    if (params.userId) conditions.push(eq(head.userId, params.userId));
    if (params.sessionKey) {
      conditions.push(eq(head.sessionKey, params.sessionKey));
    }
    if (params.before) {
      // Same direction on both columns, so the row comparison is an index
      // condition on interaction_session_heads_last_idx rather than a filter.
      conditions.push(
        sql`(${head.lastCreatedAt}, ${head.lastInteractionId}) < (${params.before.createdAt}::timestamp, ${params.before.id}::uuid)`,
      );
    }
    const rows = await db
      .select({
        sessionId: interaction.sessionId,
        headCreatedAt: head.lastCreatedAt,
        headId: head.lastInteractionId,
      })
      .from(head)
      .innerJoin(interaction, eq(interaction.id, head.lastInteractionId))
      .where(and(...conditions))
      // NULLS LAST matches the index definition; without it PostgreSQL sorts.
      .orderBy(
        sql`${head.lastCreatedAt} DESC NULLS LAST`,
        sql`${head.lastInteractionId} DESC NULLS LAST`,
      )
      .limit(params.limit + 1);
    return rows;
  }

  /**
   * Fold interactions written before the head table existed into it, one
   * bounded batch per transaction, until the marker row is gone. Safe to run
   * from every process at once and to interrupt: the marker row is locked
   * per batch (other processes skip while it is held), the position it
   * records resumes an interrupted run, and the upsert only ever moves a head
   * forward, so replaying a batch or racing the insert trigger changes
   * nothing.
   *
   * Never throws; a failure is logged and the next boot resumes.
   */
  static async backfill(
    options: { batchSize?: number; maxBatches?: number } = {},
  ): Promise<"complete" | "busy" | "partial" | "failed"> {
    const batchSize = options.batchSize ?? BACKFILL_BATCH_ROWS;
    const maxBatches = options.maxBatches ?? Number.POSITIVE_INFINITY;
    let rows = 0;
    const started = performance.now();
    try {
      for (let batch = 0; batch < maxBatches; batch++) {
        const outcome =
          await InteractionSessionHeadModel.backfillBatch(batchSize);
        if (outcome === "complete" || outcome === "busy") {
          if (outcome === "complete" && rows > 0) {
            logger.info(
              { rows, elapsedMs: Math.round(performance.now() - started) },
              "Backfilled interaction session heads",
            );
          }
          return outcome;
        }
        rows += outcome;
      }
      return "partial";
    } catch (error) {
      logger.warn(
        {
          error: error instanceof Error ? error.message : String(error),
          rows,
        },
        "Interaction session head backfill failed; will resume on next boot",
      );
      return "failed";
    }
  }

  /** One batch. Returns rows read, or why there is nothing to do. */
  private static async backfillBatch(
    batchSize: number,
  ): Promise<number | "complete" | "busy"> {
    return withDbTransaction(async (tx) => {
      const marker = await tx.execute<{ after_id: string | null }>(sql`
        SELECT after_id FROM interaction_session_heads_backfill
        WHERE id = 1 FOR UPDATE SKIP LOCKED
      `);
      if (marker.rows.length === 0) {
        const pending = await tx.execute(
          sql`SELECT 1 FROM interaction_session_heads_backfill WHERE id = 1`,
        );
        return pending.rows.length === 0 ? "complete" : "busy";
      }
      const afterId = marker.rows[0].after_id;
      // Walk the primary key; within the batch keep each session's newest
      // row and upsert it with the same forward-only rule as the trigger.
      const result = await tx.execute<{ read: number; last_id: string | null }>(
        sql`
        WITH batch AS (
          SELECT id, session_id, created_at, user_id FROM interactions
          WHERE ${afterId}::uuid IS NULL OR id > ${afterId}::uuid
          ORDER BY id
          LIMIT ${batchSize}
        ), newest AS (
          SELECT DISTINCT ON (session_id IS NULL, COALESCE(session_id, id::text))
            session_id IS NULL AS sessionless, COALESCE(session_id, id::text) AS session_key,
            created_at, id, user_id
          FROM batch
          ORDER BY session_id IS NULL, COALESCE(session_id, id::text), created_at DESC, id DESC
        ), upserted AS (
          INSERT INTO interaction_session_heads AS head
            (sessionless, session_key, last_created_at, last_interaction_id, user_id)
          SELECT sessionless, session_key, created_at, id, user_id FROM newest
          ON CONFLICT (sessionless, session_key) DO UPDATE
            SET last_created_at = excluded.last_created_at,
                last_interaction_id = excluded.last_interaction_id,
                user_id = excluded.user_id
            WHERE (excluded.last_created_at, excluded.last_interaction_id)
                > (head.last_created_at, head.last_interaction_id)
          RETURNING 1
        )
        SELECT (SELECT count(*)::int FROM batch) AS read,
               (SELECT id::text FROM batch ORDER BY id DESC LIMIT 1) AS last_id,
               (SELECT count(*) FROM upserted) AS upserted
      `,
      );
      const { read, last_id: lastId } = result.rows[0];
      if (Number(read) < batchSize) {
        await tx.execute(
          sql`DELETE FROM interaction_session_heads_backfill WHERE id = 1`,
        );
        completion.complete = true;
        return Number(read) === 0 ? "complete" : Number(read);
      }
      await tx.execute(
        sql`UPDATE interaction_session_heads_backfill SET after_id = ${lastId}::uuid WHERE id = 1`,
      );
      return Number(read);
    });
  }
}

export default InteractionSessionHeadModel;

// ============================================================
// Internal
// ============================================================

/**
 * Rows per backfill transaction. Each batch is a primary-key range read plus
 * an upsert of at most this many heads, well inside the statement timeout,
 * and short enough that the marker lock never holds up anything for long.
 */
const BACKFILL_BATCH_ROWS = 5_000;

/** Process-local completion flag; registered so tests start each case clean. */
const completion = registerProcessLocalCache({
  complete: false,
  clear() {
    this.complete = false;
  },
});
