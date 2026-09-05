import type { PaginationQuery } from "@archestra/shared";
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
  type SQL,
  sql,
} from "drizzle-orm";
import config from "@/config";
import db, { schema } from "@/database";
import { createPaginatedResult } from "@/database/utils/pagination";
import type {
  AgentRun,
  AgentRunRecord,
  AgentRunSession,
  InsertAgentRunRecord,
} from "@/types";
import { A2A_TERMINAL_TASK_STATES } from "@/types/a2a-task";
import A2AMessageModel from "./a2a/message";

/**
 * The Agent run carrying one A2A task. Holds no lifecycle state of its own — the
 * task's state machine is the record of how the work is going.
 */
class AgentRunModel {
  static async create(
    run: InsertAgentRunRecord & { id?: AgentRunRecord["id"] },
  ): Promise<AgentRunRecord> {
    const [created] = await db
      .insert(schema.agentRunsTable)
      .values(run)
      .returning();
    return created;
  }

  static async findByTaskId(taskId: string): Promise<AgentRunRecord | null> {
    const [run] = await db
      .select()
      .from(schema.agentRunsTable)
      .where(eq(schema.agentRunsTable.taskId, taskId))
      .limit(1);
    return run ?? null;
  }

  static async updateAttentionState(params: {
    taskId: string;
    attentionState: AgentRunRecord["attentionState"];
  }): Promise<boolean> {
    const updated = await db
      .update(schema.agentRunsTable)
      .set({ attentionState: params.attentionState })
      .where(
        and(
          eq(schema.agentRunsTable.taskId, params.taskId),
          isNull(schema.agentRunsTable.endedAt),
        ),
      )
      .returning({ id: schema.agentRunsTable.id });
    return updated.length > 0;
  }

  /** Sessions whose pod should still exist, across every organization. */
  static async listOpen(): Promise<AgentRunRecord[]> {
    return db
      .select()
      .from(schema.agentRunsTable)
      .where(isNull(schema.agentRunsTable.endedAt));
  }

  /** Terminal runs whose channel completion reply is still pending. */
  static async listPendingCompletionNotifications(): Promise<AgentRunRecord[]> {
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
  }): Promise<AgentRun[]> {
    const {
      logs: _logs,
      completionTarget: _completionTarget,
      completionNotificationClaimedAt: _completionNotificationClaimedAt,
      completionNotifiedAt: _completionNotifiedAt,
      activeDeadlineSeconds: _activeDeadlineSeconds,
      ...runColumns
    } = getTableColumns(schema.agentRunsTable);
    return db
      .select({
        ...runColumns,
        state: schema.a2aTasksTable.state,
        statusReason: schema.a2aTasksTable.statusReason,
        stateChangedAt: schema.a2aTasksTable.stateChangedAt,
        hardDeadlineAt: hardDeadlineAtExpression(),
        lastModelActivityAt: lastModelActivityAtExpression(),
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
          eq(schema.agentRunsTable.agentId, params.agentId),
          eq(schema.agentRunsTable.organizationId, params.organizationId),
        ),
      )
      .orderBy(desc(schema.agentRunsTable.startedAt));
  }

  /** Read-only fleet rows for run dashboards, newest first. */
  static async listDashboard(params: {
    agentIds: string[];
    organizationId: string;
    limit: number;
  }) {
    if (params.agentIds.length === 0) return [];

    const rows = await db
      .select({
        taskId: schema.agentRunsTable.taskId,
        title: schema.agentRunsTable.title,
        actorKind: schema.agentRunsTable.actorKind,
        actorId: schema.agentRunsTable.actorId,
        actorName: schema.usersTable.name,
        startedAt: schema.agentRunsTable.startedAt,
        endedAt: schema.agentRunsTable.endedAt,
        state: schema.a2aTasksTable.state,
        statusReason: schema.a2aTasksTable.statusReason,
        stateChangedAt: schema.a2aTasksTable.stateChangedAt,
        hardDeadlineAt: hardDeadlineAtExpression(),
        lastModelActivityAt: lastModelActivityAtExpression(),
        attentionState: schema.agentRunsTable.attentionState,
        agentId: schema.agentsTable.id,
        agentName: schema.agentsTable.name,
        agentIcon: schema.agentsTable.icon,
        threadId: sql<
          string | null
        >`${schema.agentRunsTable.completionTarget}->>'threadId'`,
        threadProvider: schema.chatopsChannelBindingsTable.provider,
        threadWorkspaceId: schema.chatopsChannelBindingsTable.workspaceId,
        threadChannelId: schema.chatopsChannelBindingsTable.channelId,
        threadChannelName: schema.chatopsChannelBindingsTable.channelName,
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
      .leftJoin(
        schema.usersTable,
        eq(schema.agentRunsTable.actorUserId, schema.usersTable.id),
      )
      .leftJoin(
        schema.chatopsChannelBindingsTable,
        and(
          eq(
            schema.chatopsChannelBindingsTable.id,
            sql`(${schema.agentRunsTable.completionTarget}->>'bindingId')::uuid`,
          ),
          eq(
            schema.chatopsChannelBindingsTable.organizationId,
            params.organizationId,
          ),
        ),
      )
      .where(
        and(
          inArray(schema.agentRunsTable.agentId, params.agentIds),
          eq(schema.agentRunsTable.organizationId, params.organizationId),
        ),
      )
      .orderBy(desc(schema.agentRunsTable.startedAt))
      .limit(params.limit);

    const prompts = await A2AMessageModel.findFirstUserPartsByTaskIds(
      rows.map((row) => row.taskId),
    );
    return rows.map((row) => ({
      ...row,
      prompt: extractPrompt(prompts.get(row.taskId) ?? []),
    }));
  }

  /** Chat run sessions started by one user, newest first. */
  static async listForActor(params: {
    actorUserId: string;
    organizationId: string;
    pagination: PaginationQuery;
  }) {
    const conditions = [
      eq(schema.agentRunsTable.actorKind, "user"),
      eq(schema.agentRunsTable.actorId, params.actorUserId),
      eq(schema.agentRunsTable.organizationId, params.organizationId),
    ];
    const [rows, [{ total }]] = await Promise.all([
      AgentRunModel.selectRunSessionsWhere({
        conditions,
        pagination: params.pagination,
      }),
      db
        .select({ total: sql<number>`count(*)` })
        .from(schema.agentRunsTable)
        .where(and(...conditions)),
    ]);
    return createPaginatedResult(
      await AgentRunModel.addRunPrompts(rows),
      Number(total),
      params.pagination,
    );
  }

  static async findForActorByTaskId(params: {
    taskId: string;
    actorUserId: string;
    organizationId: string;
  }): Promise<AgentRunSession | null> {
    const rows = await AgentRunModel.selectRunSessions(params);
    const [session] = await AgentRunModel.addRunPrompts(rows);
    return session ?? null;
  }

  /**
   * A single run session by task, scoped only to the organization — not
   * to the actor who started it. Used to serve shared (read-only) viewers, whose
   * access is authorized separately via {@link AgentRunShareModel}. Callers must
   * verify share access before exposing the result.
   */
  static async findSessionByTaskId(params: {
    taskId: string;
    organizationId: string;
  }): Promise<AgentRunSession | null> {
    const rows = await AgentRunModel.selectRunSessionsWhere({
      conditions: [
        eq(schema.agentRunsTable.taskId, params.taskId),
        eq(schema.agentRunsTable.organizationId, params.organizationId),
      ],
    });
    const [session] = await AgentRunModel.addRunPrompts(rows);
    return session ?? null;
  }

  /** Run sessions assigned to one project, newest first. */
  static async listForProject(params: {
    projectId: string;
    organizationId: string;
    actorUserId?: string;
  }): Promise<AgentRunSession[]> {
    const rows = await AgentRunModel.selectRunSessionsWhere({
      conditions: [
        eq(schema.agentRunsTable.projectId, params.projectId),
        eq(schema.agentRunsTable.organizationId, params.organizationId),
        ...(params.actorUserId
          ? [eq(schema.agentRunsTable.actorUserId, params.actorUserId)]
          : []),
      ],
    });
    return await AgentRunModel.addRunPrompts(rows);
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

  static async updateForActor(params: {
    taskId: string;
    actorUserId: string;
    organizationId: string;
    title?: string;
    pinnedAt?: Date | null;
    projectId?: string | null;
  }): Promise<AgentRunSession | null> {
    const updated = await db
      .update(schema.agentRunsTable)
      .set({
        title: params.title,
        pinnedAt: params.pinnedAt,
        projectId: params.projectId,
      })
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
      .set({ endedAt: new Date(), logs: params.logs, attentionState: null })
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
  ): Promise<AgentRunRecord | null> {
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

  private static async selectRunSessions(params: {
    actorUserId: string;
    organizationId: string;
    taskId?: string;
  }) {
    return AgentRunModel.selectRunSessionsWhere({
      conditions: [
        eq(schema.agentRunsTable.actorKind, "user"),
        eq(schema.agentRunsTable.actorId, params.actorUserId),
        eq(schema.agentRunsTable.organizationId, params.organizationId),
        ...(params.taskId
          ? [eq(schema.agentRunsTable.taskId, params.taskId)]
          : []),
      ],
    });
  }

  private static async selectRunSessionsWhere(params: {
    conditions: SQL[];
    pagination?: PaginationQuery;
  }) {
    const {
      logs: _logs,
      completionTarget: _completionTarget,
      completionNotificationClaimedAt: _completionNotificationClaimedAt,
      completionNotifiedAt: _completionNotifiedAt,
      activeDeadlineSeconds: _activeDeadlineSeconds,
      ...runColumns
    } = getTableColumns(schema.agentRunsTable);
    const query = db
      .select({
        ...runColumns,
        state: schema.a2aTasksTable.state,
        statusReason: schema.a2aTasksTable.statusReason,
        stateChangedAt: schema.a2aTasksTable.stateChangedAt,
        hardDeadlineAt: hardDeadlineAtExpression(),
        lastModelActivityAt: lastModelActivityAtExpression(),
        agent: {
          id: schema.agentsTable.id,
          name: schema.agentsTable.name,
          icon: schema.agentsTable.icon,
        },
        projectName: schema.projectsTable.name,
        projectIcon: schema.projectsTable.icon,
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
      .leftJoin(
        schema.projectsTable,
        eq(schema.agentRunsTable.projectId, schema.projectsTable.id),
      )
      .where(and(...params.conditions))
      .orderBy(desc(schema.agentRunsTable.startedAt))
      .$dynamic();

    return params.pagination
      ? await query
          .limit(params.pagination.limit)
          .offset(params.pagination.offset)
      : await query;
  }

  private static async addRunPrompts(
    rows: Awaited<ReturnType<typeof AgentRunModel.selectRunSessions>>,
  ): Promise<AgentRunSession[]> {
    const prompts = await A2AMessageModel.findFirstUserPartsByTaskIds(
      rows.map((row) => row.taskId),
    );
    return rows.map((row) => ({
      ...row,
      prompt: extractPrompt(prompts.get(row.taskId) ?? []),
    }));
  }
}

export default AgentRunModel;

const NOTIFICATION_CLAIM_TTL_MS = 2 * 60 * 1_000;

function extractPrompt(parts: unknown[]): string {
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

function hardDeadlineAtExpression(): SQL<Date> {
  return sql<Date>`
    ${schema.agentRunsTable.startedAt} +
    COALESCE(
      ${schema.agentRunsTable.activeDeadlineSeconds},
      COALESCE(
        (${schema.agentsTable.runtime}->>'ttlHours')::integer,
        ${config.agentRuntime.defaultTtlHours}
      ) * 60 * 60
    ) * interval '1 second'
  `.mapWith(schema.agentRunsTable.startedAt);
}

function lastModelActivityAtExpression(): SQL<Date | null> {
  return sql<Date | null>`(
    SELECT ${schema.interactionsTable.createdAt}
    FROM ${schema.interactionsTable}
    WHERE ${schema.interactionsTable.runId} = ${schema.agentRunsTable.taskId}::text
    ORDER BY ${schema.interactionsTable.createdAt} DESC
    LIMIT 1
  )`.mapWith(schema.agentRunsTable.startedAt);
}
