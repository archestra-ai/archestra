import { and, count, desc, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import db, { schema } from "@/database";
import type {
  ScheduleTrigger,
  ScheduleTriggerRun,
  ScheduleTriggerRunStatus,
} from "@/types";

class ScheduleTriggerRunModel {
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
    status?: ScheduleTriggerRunStatus;
  }): Promise<ScheduleTriggerRun[]> {
    const conditions = [
      eq(schema.scheduleTriggerRunsTable.organizationId, params.organizationId),
      eq(schema.scheduleTriggerRunsTable.triggerId, params.triggerId),
    ];

    if (params.status) {
      conditions.push(
        eq(schema.scheduleTriggerRunsTable.status, params.status),
      );
    }

    let query = db
      .select()
      .from(schema.scheduleTriggerRunsTable)
      .where(and(...conditions))
      .orderBy(desc(schema.scheduleTriggerRunsTable.createdAt))
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
