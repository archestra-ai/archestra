import {
  and,
  desc,
  eq,
  getTableColumns,
  inArray,
  isNotNull,
  isNull,
  lt,
  or,
} from "drizzle-orm";
import db, { schema } from "@/database";
import type {
  AgentExecution,
  AgentExecutionSession,
  AgentRun,
  InsertAgentRun,
} from "@/types";
import { A2A_TERMINAL_TASK_STATES } from "@/types/a2a-task";
import A2AMessageModel from "./a2a/message";

/**
 * The Agent run carrying one A2A task. Holds no lifecycle state of its own — the
 * task's state machine is the record of how the work is going.
 */
class AgentRunModel {
  static async create(run: InsertAgentRun): Promise<AgentRun> {
    const [created] = await db
      .insert(schema.agentRunsTable)
      .values(run)
      .returning();
    return created;
  }

  static async findByTaskId(taskId: string): Promise<AgentRun | null> {
    const [run] = await db
      .select()
      .from(schema.agentRunsTable)
      .where(eq(schema.agentRunsTable.taskId, taskId))
      .limit(1);
    return run ?? null;
  }

  /** Sessions whose pod should still exist, across every organization. */
  static async listOpen(): Promise<AgentRun[]> {
    return db
      .select()
      .from(schema.agentRunsTable)
      .where(isNull(schema.agentRunsTable.endedAt));
  }

  /** Terminal executions whose channel completion reply is still pending. */
  static async listPendingCompletionNotifications(): Promise<AgentRun[]> {
    return db
      .select(getTableColumns(schema.agentRunsTable))
      .from(schema.agentRunsTable)
      .innerJoin(
        schema.a2aTasksTable,
        eq(schema.agentRunsTable.taskId, schema.a2aTasksTable.id),
      )
      .where(
        and(
          isNotNull(schema.agentRunsTable.completionTarget),
          isNull(schema.agentRunsTable.completionNotifiedAt),
          inArray(schema.a2aTasksTable.state, A2A_TERMINAL_TASK_STATES),
        ),
      );
  }

  static async listForAgent(params: {
    agentId: string;
    organizationId: string;
  }): Promise<AgentExecution[]> {
    const {
      logs: _logs,
      completionTarget: _completionTarget,
      completionNotificationClaimedAt: _completionNotificationClaimedAt,
      completionNotifiedAt: _completionNotifiedAt,
      ...runColumns
    } = getTableColumns(schema.agentRunsTable);
    return db
      .select({
        ...runColumns,
        state: schema.a2aTasksTable.state,
        statusReason: schema.a2aTasksTable.statusReason,
        stateChangedAt: schema.a2aTasksTable.stateChangedAt,
      })
      .from(schema.agentRunsTable)
      .innerJoin(
        schema.a2aTasksTable,
        eq(schema.agentRunsTable.taskId, schema.a2aTasksTable.id),
      )
      .where(
        and(
          eq(schema.agentRunsTable.agentId, params.agentId),
          eq(schema.agentRunsTable.organizationId, params.organizationId),
        ),
      )
      .orderBy(desc(schema.agentRunsTable.startedAt));
  }

  /** Chat execution sessions started by one user, newest first. */
  static async listForActor(params: {
    actorUserId: string;
    organizationId: string;
  }): Promise<AgentExecutionSession[]> {
    const rows = await AgentRunModel.selectExecutionSessions({
      actorUserId: params.actorUserId,
      organizationId: params.organizationId,
    });
    return await AgentRunModel.addExecutionPrompts(rows);
  }

  static async findForActorByTaskId(params: {
    taskId: string;
    actorUserId: string;
    organizationId: string;
  }): Promise<AgentExecutionSession | null> {
    const rows = await AgentRunModel.selectExecutionSessions(params);
    const [session] = await AgentRunModel.addExecutionPrompts(rows);
    return session ?? null;
  }

  static async updateTitleIfCurrent(params: {
    taskId: string;
    expectedTitle: string;
    title: string;
  }): Promise<boolean> {
    const updated = await db
      .update(schema.agentRunsTable)
      .set({ title: params.title })
      .where(
        and(
          eq(schema.agentRunsTable.taskId, params.taskId),
          eq(schema.agentRunsTable.title, params.expectedTitle),
        ),
      )
      .returning({ id: schema.agentRunsTable.id });
    return updated.length > 0;
  }

  static async updateTitleForActor(params: {
    taskId: string;
    actorUserId: string;
    organizationId: string;
    title: string;
  }): Promise<AgentExecutionSession | null> {
    const updated = await db
      .update(schema.agentRunsTable)
      .set({ title: params.title })
      .where(
        and(
          eq(schema.agentRunsTable.taskId, params.taskId),
          eq(schema.agentRunsTable.actorUserId, params.actorUserId),
          eq(schema.agentRunsTable.organizationId, params.organizationId),
        ),
      )
      .returning({ taskId: schema.agentRunsTable.taskId });
    if (updated.length === 0) return null;
    return await AgentRunModel.findForActorByTaskId(params);
  }

  /**
   * Mark a session finished. Returns false when it was already closed, so a
   * caller racing the reconciler can tell whether it owns the teardown.
   */
  static async close(params: { id: string; logs?: string }): Promise<boolean> {
    const closed = await db
      .update(schema.agentRunsTable)
      .set({ endedAt: new Date(), logs: params.logs })
      .where(
        and(
          eq(schema.agentRunsTable.id, params.id),
          isNull(schema.agentRunsTable.endedAt),
        ),
      )
      .returning({ id: schema.agentRunsTable.id });
    return closed.length > 0;
  }

  static async clearVirtualApiKey(id: string): Promise<void> {
    await db
      .update(schema.agentRunsTable)
      .set({ virtualApiKeyId: null })
      .where(eq(schema.agentRunsTable.id, id));
  }

  /** Claim delivery, including a claim abandoned by a crashed sender. */
  static async claimCompletionNotification(
    taskId: string,
  ): Promise<AgentRun | null> {
    const staleBefore = new Date(Date.now() - NOTIFICATION_CLAIM_TTL_MS);
    const [claimed] = await db
      .update(schema.agentRunsTable)
      .set({ completionNotificationClaimedAt: new Date() })
      .where(
        and(
          eq(schema.agentRunsTable.taskId, taskId),
          isNull(schema.agentRunsTable.completionNotifiedAt),
          or(
            isNull(schema.agentRunsTable.completionNotificationClaimedAt),
            lt(
              schema.agentRunsTable.completionNotificationClaimedAt,
              staleBefore,
            ),
          ),
        ),
      )
      .returning();
    return claimed ?? null;
  }

  /** Record provider acceptance; only an active claimant can finish delivery. */
  static async markCompletionNotified(id: string): Promise<void> {
    await db
      .update(schema.agentRunsTable)
      .set({ completionNotifiedAt: new Date() })
      .where(
        and(
          eq(schema.agentRunsTable.id, id),
          isNotNull(schema.agentRunsTable.completionNotificationClaimedAt),
          isNull(schema.agentRunsTable.completionNotifiedAt),
        ),
      );
  }

  /** Release a failed attempt so the next reconciliation can retry it. */
  static async releaseCompletionNotification(id: string): Promise<void> {
    await db
      .update(schema.agentRunsTable)
      .set({ completionNotificationClaimedAt: null })
      .where(
        and(
          eq(schema.agentRunsTable.id, id),
          isNull(schema.agentRunsTable.completionNotifiedAt),
        ),
      );
  }

  // === Internal helpers ===

  private static async selectExecutionSessions(params: {
    actorUserId: string;
    organizationId: string;
    taskId?: string;
  }) {
    const {
      logs: _logs,
      completionTarget: _completionTarget,
      completionNotificationClaimedAt: _completionNotificationClaimedAt,
      completionNotifiedAt: _completionNotifiedAt,
      ...runColumns
    } = getTableColumns(schema.agentRunsTable);
    return await db
      .select({
        ...runColumns,
        state: schema.a2aTasksTable.state,
        statusReason: schema.a2aTasksTable.statusReason,
        stateChangedAt: schema.a2aTasksTable.stateChangedAt,
        agent: {
          id: schema.agentsTable.id,
          name: schema.agentsTable.name,
          icon: schema.agentsTable.icon,
        },
      })
      .from(schema.agentRunsTable)
      .innerJoin(
        schema.a2aTasksTable,
        eq(schema.agentRunsTable.taskId, schema.a2aTasksTable.id),
      )
      .innerJoin(
        schema.agentsTable,
        eq(schema.agentRunsTable.agentId, schema.agentsTable.id),
      )
      .where(
        and(
          eq(schema.agentRunsTable.actorKind, "user"),
          eq(schema.agentRunsTable.actorId, params.actorUserId),
          eq(schema.agentRunsTable.organizationId, params.organizationId),
          ...(params.taskId
            ? [eq(schema.agentRunsTable.taskId, params.taskId)]
            : []),
        ),
      )
      .orderBy(desc(schema.agentRunsTable.startedAt));
  }

  private static async addExecutionPrompts(
    rows: Awaited<ReturnType<typeof AgentRunModel.selectExecutionSessions>>,
  ): Promise<AgentExecutionSession[]> {
    const messages = await A2AMessageModel.findByTaskIds(
      rows.map((row) => row.taskId),
    );
    return rows.map((row) => ({
      ...row,
      prompt: extractPrompt(messages.get(row.taskId) ?? []),
    }));
  }
}

export default AgentRunModel;

const NOTIFICATION_CLAIM_TTL_MS = 2 * 60 * 1_000;

function extractPrompt(
  messages: Array<{ role: string; parts: unknown[] }>,
): string {
  const userMessage = messages.find((message) => message.role === "ROLE_USER");
  const parts = userMessage?.parts ?? [];
  return parts
    .map((part) =>
      part &&
      typeof part === "object" &&
      typeof (part as { text?: unknown }).text === "string"
        ? (part as { text: string }).text
        : "",
    )
    .join("")
    .trim();
}
