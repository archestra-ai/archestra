import {
  and,
  count,
  desc,
  eq,
  getTableColumns,
  inArray,
  isNotNull,
  isNull,
  sql,
} from "drizzle-orm";
import { z } from "zod";
import db, { schema } from "@/database";
import { decodeCursor } from "@/database/utils/pagination";
import type {
  ScheduleRunBlocker,
  ScheduleTrigger,
  ScheduleTriggerRun,
  ScheduleTriggerRunKind,
  ScheduleTriggerRunStatus,
} from "@/types";
import TaskModel from "./task";

class ScheduleTriggerRunModel {
  /** Claim one due tick, persist its result and queue its work atomically. */
  static async recordDueRun(params: {
    trigger: ScheduleTrigger;
    now: Date;
    skip?: { error: string; blockedBy: ScheduleRunBlocker };
  }): Promise<ScheduleTriggerRun | null> {
    const { trigger, now, skip } = params;
    return db.transaction(async (tx) => {
      const [claimed] = await tx
        .update(schema.scheduleTriggersTable)
        .set({ lastExecutedAt: now })
        .where(
          and(
            eq(schema.scheduleTriggersTable.id, trigger.id),
            eq(schema.scheduleTriggersTable.enabled, true),
            trigger.lastExecutedAt
              ? eq(
                  schema.scheduleTriggersTable.lastExecutedAt,
                  trigger.lastExecutedAt,
                )
              : isNull(schema.scheduleTriggersTable.lastExecutedAt),
          ),
        )
        .returning({ id: schema.scheduleTriggersTable.id });
      if (!claimed) return null;
      const [run] = await tx
        .insert(schema.scheduleTriggerRunsTable)
        .values({
          organizationId: trigger.organizationId,
          triggerId: trigger.id,
          runKind: "due",
          startedAt: now,
          ...(skip
            ? {
                status: "failed" as const,
                completedAt: now,
                error: skip.error,
                blockedBy: skip.blockedBy,
              }
            : {}),
        })
        .returning();
      if (!skip)
        await TaskModel.create(
          {
            taskType: "schedule_trigger_run_execute",
            payload: { runId: run.id, triggerId: trigger.id },
          },
          tx,
        );
      return run;
    });
  }

  /** Include queue deliveries still launching, before a runtime task is linked. */
  static async findQueuedExecutions() {
    return db
      .select({
        triggerId: sql<
          string | null
        >`${schema.tasksTable.payload}->>'triggerId'`,
        runId: schema.scheduleTriggerRunsTable.id,
        chatConversationId: schema.scheduleTriggerRunsTable.chatConversationId,
        startedAt:
          sql<Date>`coalesce(${schema.scheduleTriggerRunsTable.startedAt}, ${schema.tasksTable.createdAt})`.mapWith(
            schema.tasksTable.createdAt,
          ),
      })
      .from(schema.tasksTable)
      .leftJoin(
        schema.scheduleTriggerRunsTable,
        sql`${schema.scheduleTriggerRunsTable.id}::text = ${schema.tasksTable.payload}->>'runId'`,
      )
      .where(
        and(
          eq(schema.tasksTable.taskType, "schedule_trigger_run_execute"),
          inArray(schema.tasksTable.status, ["pending", "processing"]),
        ),
      );
  }

  static async create(params: {
    organizationId: string;
    triggerId: string;
    runKind: "due" | "manual";
    initiatedByUserId?: string;
  }): Promise<ScheduleTriggerRun> {
    const [run] = await db
      .insert(schema.scheduleTriggerRunsTable)
      .values({
        organizationId: params.organizationId,
        triggerId: params.triggerId,
        runKind: params.runKind,
        status: "running",
        initiatedByUserId: params.initiatedByUserId,
        startedAt: new Date(),
      })
      .returning();

    return run;
  }

  static async createManualRun(params: {
    trigger: ScheduleTrigger;
    initiatedByUserId: string;
  }): Promise<ScheduleTriggerRun> {
    return ScheduleTriggerRunModel.create({
      organizationId: params.trigger.organizationId,
      triggerId: params.trigger.id,
      runKind: "manual",
      initiatedByUserId: params.initiatedByUserId,
    });
  }

  static async countByTrigger(params: {
    organizationId: string;
    triggerId: string;
    status?: ScheduleTriggerRunStatus;
    runKind?: ScheduleTriggerRunKind;
  }): Promise<number> {
    const conditions = [
      eq(schema.scheduleTriggerRunsTable.organizationId, params.organizationId),
      eq(schema.scheduleTriggerRunsTable.triggerId, params.triggerId),
    ];

    if (params.status) {
      conditions.push(
        eq(schema.scheduleTriggerRunsTable.status, params.status),
      );
    }

    if (params.runKind)
      conditions.push(
        eq(schema.scheduleTriggerRunsTable.runKind, params.runKind),
      );

    const [result] = await db
      .select({ count: count() })
      .from(schema.scheduleTriggerRunsTable)
      .where(and(...conditions));

    return result?.count ?? 0;
  }

  static async listByTrigger(params: {
    organizationId: string;
    triggerId: string;
    limit?: number;
    offset?: number;
    cursor?: string;
    status?: ScheduleTriggerRunStatus;
    runKind?: ScheduleTriggerRunKind;
  }): Promise<(ScheduleTriggerRun & { cursorCreatedAt: string })[]> {
    const conditions = [
      eq(schema.scheduleTriggerRunsTable.organizationId, params.organizationId),
      eq(schema.scheduleTriggerRunsTable.triggerId, params.triggerId),
    ];

    if (params.status) {
      conditions.push(
        eq(schema.scheduleTriggerRunsTable.status, params.status),
      );
    }

    if (params.runKind)
      conditions.push(
        eq(schema.scheduleTriggerRunsTable.runKind, params.runKind),
      );

    const position = decodeCursor(params.cursor);
    if (
      position &&
      z.uuid().safeParse(position.id).success &&
      !Number.isNaN(Date.parse(position.value))
    ) {
      conditions.push(
        sql`(${schema.scheduleTriggerRunsTable.createdAt}, ${schema.scheduleTriggerRunsTable.id}) < (${position.value}::timestamptz, ${position.id}::uuid)`,
      );
    }

    let query = db
      .select({
        ...getTableColumns(schema.scheduleTriggerRunsTable),
        // Preserve PostgreSQL microseconds when encoding the next page.
        cursorCreatedAt: sql<string>`${schema.scheduleTriggerRunsTable.createdAt}::text`,
      })
      .from(schema.scheduleTriggerRunsTable)
      .where(and(...conditions))
      .orderBy(
        desc(schema.scheduleTriggerRunsTable.createdAt),
        desc(schema.scheduleTriggerRunsTable.id),
      )
      .$dynamic();

    if (params.limit !== undefined) {
      query = query.limit(params.limit);
    }

    if (params.offset !== undefined) {
      query = query.offset(params.offset);
    }

    return await query;
  }

  static async findById(id: string): Promise<ScheduleTriggerRun | null> {
    const [run] = await db
      .select()
      .from(schema.scheduleTriggerRunsTable)
      .where(eq(schema.scheduleTriggerRunsTable.id, id));

    return run ?? null;
  }

  static async findByChatConversationIds(params: {
    organizationId: string;
    conversationIds: string[];
  }) {
    if (params.conversationIds.length === 0) return [];
    return db
      .select({
        id: schema.scheduleTriggerRunsTable.id,
        triggerId: schema.scheduleTriggerRunsTable.triggerId,
        createdAt: schema.scheduleTriggerRunsTable.createdAt,
        runKind: schema.scheduleTriggerRunsTable.runKind,
        chatConversationId: schema.scheduleTriggerRunsTable.chatConversationId,
        scheduleName: schema.scheduleTriggersTable.name,
      })
      .from(schema.scheduleTriggerRunsTable)
      .innerJoin(
        schema.scheduleTriggersTable,
        eq(
          schema.scheduleTriggersTable.id,
          schema.scheduleTriggerRunsTable.triggerId,
        ),
      )
      .where(
        and(
          eq(
            schema.scheduleTriggerRunsTable.organizationId,
            params.organizationId,
          ),
          inArray(
            schema.scheduleTriggerRunsTable.chatConversationId,
            params.conversationIds,
          ),
        ),
      );
  }

  static async findByChatConversationId(
    chatConversationId: string,
  ): Promise<ScheduleTriggerRun | null> {
    const [run] = await db
      .select()
      .from(schema.scheduleTriggerRunsTable)
      .where(
        eq(
          schema.scheduleTriggerRunsTable.chatConversationId,
          chatConversationId,
        ),
      );

    return run ?? null;
  }

  /** Link before execution starts, so queue retries cannot launch a second runtime. */
  static async setRuntimeTaskId(params: {
    runId: string;
    taskId: string;
  }): Promise<boolean> {
    const [updated] = await db
      .update(schema.scheduleTriggerRunsTable)
      .set({ runtimeTaskId: params.taskId })
      .where(
        and(
          eq(schema.scheduleTriggerRunsTable.id, params.runId),
          eq(schema.scheduleTriggerRunsTable.status, "running"),
          isNull(schema.scheduleTriggerRunsTable.runtimeTaskId),
        ),
      )
      .returning({ id: schema.scheduleTriggerRunsTable.id });
    return !!updated;
  }

  /** Batch-read durable outcomes, including tasks settled after a backend restart. */
  static async findRunningRuntimeTasks() {
    return await db
      .select({
        runId: schema.scheduleTriggerRunsTable.id,
        triggerId: schema.scheduleTriggerRunsTable.triggerId,
        runtimeTaskId: schema.scheduleTriggerRunsTable.runtimeTaskId,
        startedAt: schema.scheduleTriggerRunsTable.startedAt,
        createdAt: schema.scheduleTriggerRunsTable.createdAt,
        runtimeRunId: schema.agentRunsTable.id,
        endedAt: schema.agentRunsTable.endedAt,
        deadline: schema.agentWorkspacesTable.expiresAt,
        maximumDurationSeconds: schema.agentRunsTable.activeDeadlineSeconds,
        state: schema.a2aTasksTable.state,
        statusReason: schema.a2aTasksTable.statusReason,
        agentName: schema.agentsTable.name,
      })
      .from(schema.scheduleTriggerRunsTable)
      .leftJoin(
        schema.a2aTasksTable,
        eq(
          schema.a2aTasksTable.id,
          schema.scheduleTriggerRunsTable.runtimeTaskId,
        ),
      )
      .leftJoin(
        schema.agentsTable,
        eq(schema.agentsTable.id, schema.a2aTasksTable.agentId),
      )
      .leftJoin(
        schema.agentRunsTable,
        eq(
          schema.agentRunsTable.taskId,
          schema.scheduleTriggerRunsTable.runtimeTaskId,
        ),
      )
      .leftJoin(
        schema.agentWorkspacesTable,
        eq(
          schema.agentWorkspacesTable.workloadName,
          schema.agentRunsTable.workloadName,
        ),
      )
      .where(
        and(
          eq(schema.scheduleTriggerRunsTable.status, "running"),
          isNotNull(schema.scheduleTriggerRunsTable.runtimeTaskId),
        ),
      );
  }

  static async markCompleted(params: {
    runId: string;
    status: Exclude<ScheduleTriggerRunStatus, "running">;
    error?: string | null;
  }): Promise<ScheduleTriggerRun | null> {
    const [run] = await db
      .update(schema.scheduleTriggerRunsTable)
      .set({
        status: params.status,
        completedAt: new Date(),
        error: params.error ?? null,
      })
      .where(
        and(
          eq(schema.scheduleTriggerRunsTable.id, params.runId),
          eq(schema.scheduleTriggerRunsTable.status, "running"),
        ),
      )
      .returning();

    return run ?? null;
  }

  /**
   * Link a run to its chat conversation. Compare-and-swap on a null
   * `chat_conversation_id` so the up-front (execution) path and the lazy (view)
   * path can't both create a conversation: returns true only for the writer
   * that actually set it.
   */
  static async setChatConversationId(
    runId: string,
    conversationId: string,
  ): Promise<boolean> {
    const [updated] = await db
      .update(schema.scheduleTriggerRunsTable)
      .set({ chatConversationId: conversationId })
      .where(
        and(
          eq(schema.scheduleTriggerRunsTable.id, runId),
          isNull(schema.scheduleTriggerRunsTable.chatConversationId),
        ),
      )
      .returning({ id: schema.scheduleTriggerRunsTable.id });
    return !!updated;
  }
}

export default ScheduleTriggerRunModel;
