import type { UIMessageChunk } from "ai";
import { and, asc, desc, eq, gt, inArray, lt, sql } from "drizzle-orm";
import db, { schema, withDbTransaction } from "@/database";
import type {
  ChatActiveRun,
  ChatActiveRunEvent,
  ChatActiveRunStatus,
} from "@/types";

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
  }): Promise<void> {
    if (params.payloads.length === 0) {
      return;
    }

    if (!params.touchRun) {
      await db.insert(schema.chatActiveRunEventsTable).values({
        runId: params.runId,
        seq: params.seq,
        payloads: params.payloads,
      });
      return;
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
  }

  static async findReplayableByConversation(params: {
    conversationId: string;
    organizationId: string;
    terminalGraceMs: number;
  }): Promise<ChatActiveRun | null> {
    const terminalCutoff = new Date(Date.now() - params.terminalGraceMs);
    const [run] = await db
      .select()
      .from(schema.chatActiveRunsTable)
      .where(
        and(
          eq(schema.chatActiveRunsTable.conversationId, params.conversationId),
          eq(schema.chatActiveRunsTable.organizationId, params.organizationId),
          sql`(${schema.chatActiveRunsTable.status} = 'running' OR ${schema.chatActiveRunsTable.updatedAt} > ${terminalCutoff})`,
        ),
      )
      .orderBy(desc(schema.chatActiveRunsTable.createdAt))
      .limit(1);

    return run ?? null;
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
