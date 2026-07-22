import type { UIMessageChunk } from "ai";
import { and, asc, desc, eq, gt, inArray, lt, sql } from "drizzle-orm";
import db, { schema, withDbTransaction } from "@/database";
import type {
  ChatActiveRun,
  ChatActiveRunEvent,
  ChatActiveRunStatus,
} from "@/types";

// "run_missing" means the parent run row was deleted (e.g. its conversation was
// hard-deleted and cascaded) before this append landed, so the write is a
// no-longer-relevant lifecycle event rather than a failure to surface.
type AppendEventsResult = "appended" | "run_missing";

class ActiveChatRunModel {
  static async create(params: {
    conversationId: string;
    userId: string;
    organizationId: string;
  }): Promise<ChatActiveRun | null> {
    const [run] = await db
      .insert(schema.chatActiveRunsTable)
      .values({
        ...params,
        status: "running",
      })
      .onConflictDoNothing()
      .returning();

    return run ?? null;
  }

  static async appendEvents(params: {
    runId: string;
    seq: number;
    payloads: UIMessageChunk[];
    touchRun?: boolean;
  }): Promise<AppendEventsResult> {
    if (params.payloads.length === 0) {
      return "appended";
    }

    try {
      if (!params.touchRun) {
        await db.insert(schema.chatActiveRunEventsTable).values({
          runId: params.runId,
          seq: params.seq,
          payloads: params.payloads,
        });
        return "appended";
      }

      await withDbTransaction(async (tx) => {
        await tx.insert(schema.chatActiveRunEventsTable).values({
          runId: params.runId,
          seq: params.seq,
          payloads: params.payloads,
        });
        await tx
          .update(schema.chatActiveRunsTable)
          .set({ updatedAt: new Date() })
          .where(eq(schema.chatActiveRunsTable.id, params.runId));
      });
      return "appended";
    } catch (error) {
      if (isRunEventsFkViolation(error)) {
        return "run_missing";
      }
      throw error;
    }
  }

  static async findReplayableByConversation(params: {
    conversationId: string;
    organizationId: string;
    terminalGraceMs: number;
  }): Promise<ChatActiveRun | null> {
    // Only the conversation's most recent run is reconnectable. Fetch it
    // unconditionally and decide replayability from its own status, rather than
    // filtering in SQL — a status filter would skip a non-replayable latest run
    // and fall through to an older one (e.g. replaying turn 1's completed run
    // after turn 2 was cancelled), reconnecting the client to a stale stream.
    const [run] = await db
      .select()
      .from(schema.chatActiveRunsTable)
      .where(
        and(
          eq(schema.chatActiveRunsTable.conversationId, params.conversationId),
          eq(schema.chatActiveRunsTable.organizationId, params.organizationId),
        ),
      )
      .orderBy(desc(schema.chatActiveRunsTable.createdAt))
      .limit(1);

    if (!run) {
      return null;
    }

    // A still-'running' run is always reconnectable. Grace-window replay exists
    // to deliver a final answer the client missed while disconnected, so a
    // terminal run is replayable only within the window — except 'cancelled':
    // the user stopped it, so there is no answer to deliver, and replaying its
    // partial (e.g. a tool call cut off before its result) makes the client
    // resume into a dangling stream that loops the chat view on reload. The
    // conversation refetch is the source of truth for a cancelled run.
    const withinGrace =
      Date.now() - run.updatedAt.getTime() < params.terminalGraceMs;
    const isReplayable =
      run.status === "running" || (run.status !== "cancelled" && withinGrace);

    return isReplayable ? run : null;
  }

  static async findRunningByConversation(
    conversationId: string,
  ): Promise<ChatActiveRun | null> {
    const [run] = await db
      .select()
      .from(schema.chatActiveRunsTable)
      .where(
        and(
          eq(schema.chatActiveRunsTable.conversationId, conversationId),
          eq(schema.chatActiveRunsTable.status, "running"),
        ),
      )
      .limit(1);

    return run ?? null;
  }

  static async findById(runId: string): Promise<ChatActiveRun | null> {
    const [run] = await db
      .select()
      .from(schema.chatActiveRunsTable)
      .where(eq(schema.chatActiveRunsTable.id, runId))
      .limit(1);

    return run ?? null;
  }

  static async readEventsAfter(params: {
    runId: string;
    seq: number;
  }): Promise<ChatActiveRunEvent[]> {
    return db
      .select()
      .from(schema.chatActiveRunEventsTable)
      .where(
        and(
          eq(schema.chatActiveRunEventsTable.runId, params.runId),
          gt(schema.chatActiveRunEventsTable.seq, params.seq),
        ),
      )
      .orderBy(asc(schema.chatActiveRunEventsTable.seq));
  }

  /**
   * Read the run's status together with its events after `seq` in ONE
   * statement, for the replay poll loop that wakes twice a second per
   * reconnected client. Beyond halving the loop's query count, the single
   * snapshot carries an ordering guarantee separate reads don't: the writer
   * commits its final events before marking the run terminal, so a snapshot
   * that observes a terminal status already contains every event — no
   * follow-up catch-up read is needed.
   *
   * Returns null when the run row is gone (its conversation was hard-deleted
   * and cascaded, which also removes all events).
   */
  static async readStatusAndEventsAfter(params: {
    runId: string;
    seq: number;
  }): Promise<{
    status: ChatActiveRunStatus;
    events: ChatActiveRunEvent[];
  } | null> {
    const rows = await db
      .select({
        status: schema.chatActiveRunsTable.status,
        event: schema.chatActiveRunEventsTable,
      })
      .from(schema.chatActiveRunsTable)
      .leftJoin(
        schema.chatActiveRunEventsTable,
        and(
          eq(
            schema.chatActiveRunEventsTable.runId,
            schema.chatActiveRunsTable.id,
          ),
          gt(schema.chatActiveRunEventsTable.seq, params.seq),
        ),
      )
      .where(eq(schema.chatActiveRunsTable.id, params.runId))
      .orderBy(asc(schema.chatActiveRunEventsTable.seq));

    const [first] = rows;
    if (!first) {
      return null;
    }

    return {
      status: first.status,
      events: rows
        .map((row) => row.event)
        .filter((event): event is ChatActiveRunEvent => event !== null),
    };
  }

  static async requestStop(params: {
    conversationId: string;
    organizationId: string;
  }): Promise<ChatActiveRun | null> {
    const [run] = await db
      .update(schema.chatActiveRunsTable)
      .set({ stopRequestedAt: new Date(), updatedAt: new Date() })
      .where(
        and(
          eq(schema.chatActiveRunsTable.conversationId, params.conversationId),
          eq(schema.chatActiveRunsTable.organizationId, params.organizationId),
          eq(schema.chatActiveRunsTable.status, "running"),
        ),
      )
      .returning();

    return run ?? null;
  }

  // Only a 'running' row transitions to terminal. Guarding on status makes
  // terminal->terminal a no-op, so a late-finishing drain cannot overwrite a
  // status the stale reaper or shutdown cleanup already set.
  static async markTerminal(params: {
    runId: string;
    status: Exclude<ChatActiveRunStatus, "running">;
    error?: string | null;
  }): Promise<ChatActiveRun | null> {
    const [run] = await db
      .update(schema.chatActiveRunsTable)
      .set({
        status: params.status,
        error: params.error ?? null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(schema.chatActiveRunsTable.id, params.runId),
          eq(schema.chatActiveRunsTable.status, "running"),
        ),
      )
      .returning();

    return run ?? null;
  }

  static async markRunningAsFailedByIds(params: {
    ids: string[];
    error: string;
  }): Promise<number> {
    if (params.ids.length === 0) {
      return 0;
    }

    const runs = await db
      .update(schema.chatActiveRunsTable)
      .set({
        status: "failed",
        error: params.error,
        updatedAt: new Date(),
      })
      .where(
        and(
          inArray(schema.chatActiveRunsTable.id, params.ids),
          eq(schema.chatActiveRunsTable.status, "running"),
        ),
      )
      .returning({ id: schema.chatActiveRunsTable.id });

    return runs.length;
  }

  static async markStaleRunningAsFailed(staleMs: number): Promise<number> {
    const cutoff = new Date(Date.now() - staleMs);
    const runs = await db
      .update(schema.chatActiveRunsTable)
      .set({
        status: "failed",
        error: "Chat stream became stale before completing.",
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(schema.chatActiveRunsTable.status, "running"),
          lt(schema.chatActiveRunsTable.updatedAt, cutoff),
        ),
      )
      .returning({ id: schema.chatActiveRunsTable.id });

    return runs.length;
  }

  static async deleteTerminalOlderThan(retentionMs: number): Promise<number> {
    const cutoff = new Date(Date.now() - retentionMs);
    const runs = await db
      .delete(schema.chatActiveRunsTable)
      .where(
        and(
          sql`${schema.chatActiveRunsTable.status} != 'running'`,
          lt(schema.chatActiveRunsTable.updatedAt, cutoff),
        ),
      )
      .returning({ id: schema.chatActiveRunsTable.id });

    return runs.length;
  }
}

export default ActiveChatRunModel;

// === internal helpers ===

const RUN_EVENTS_RUN_FK_CONSTRAINT =
  "chat_active_run_events_run_id_chat_active_runs_id_fk";

// Only the exact run_id foreign key counts as "run gone": a generic FK helper
// would also swallow unrelated violations. Drizzle wraps the pg error as
// `cause`, so walk the chain. Mirrors skill-sandbox.ts's isConversationFkViolation.
function isRunEventsFkViolation(error: unknown): boolean {
  let current: unknown = error;
  while (current instanceof Error) {
    const candidate = current as Error & {
      code?: unknown;
      constraint?: unknown;
    };
    if (
      candidate.code === "23503" &&
      candidate.constraint === RUN_EVENTS_RUN_FK_CONSTRAINT
    ) {
      return true;
    }
    current = candidate.cause;
  }
  return false;
}
