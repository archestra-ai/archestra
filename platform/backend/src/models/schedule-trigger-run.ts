import { and, count, desc, eq } from "drizzle-orm";
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

  static async markCompleted(params: {
    runId: string;
    status: Extract<ScheduleTriggerRunStatus, "success" | "failed">;
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

  static async setChatConversationId(
    runId: string,
    conversationId: string,
  ): Promise<void> {
    await db
      .update(schema.scheduleTriggerRunsTable)
      .set({ chatConversationId: conversationId })
      .where(eq(schema.scheduleTriggerRunsTable.id, runId));
  }
}

export default ScheduleTriggerRunModel;
