import { and, desc, eq, sql } from "drizzle-orm";
import db, { schema } from "@/database";
import logger from "@/logging";
import type {
  ScheduleTrigger,
  ScheduleTriggerStatus,
} from "@/types/agent-schedule-trigger";

class AgentScheduleTriggerModel {
  static async findById(id: string): Promise<ScheduleTrigger | undefined> {
    const [trigger] = await db
      .select()
      .from(schema.agentScheduleTriggersTable)
      .where(eq(schema.agentScheduleTriggersTable.id, id))
      .limit(1);
    return trigger;
  }

  static async findByIdAndOrganization(params: {
    id: string;
    organizationId: string;
  }): Promise<ScheduleTrigger | undefined> {
    const { id, organizationId } = params;
    const [trigger] = await db
      .select()
      .from(schema.agentScheduleTriggersTable)
      .where(
        and(
          eq(schema.agentScheduleTriggersTable.id, id),
          eq(
            schema.agentScheduleTriggersTable.organizationId,
            organizationId,
          ),
        ),
      )
      .limit(1);
    return trigger;
  }

  static async findByAgentId(params: {
    agentId: string;
    organizationId: string;
  }): Promise<ScheduleTrigger[]> {
    const { agentId, organizationId } = params;
    return await db
      .select()
      .from(schema.agentScheduleTriggersTable)
      .where(
        and(
          eq(schema.agentScheduleTriggersTable.agentId, agentId),
          eq(
            schema.agentScheduleTriggersTable.organizationId,
            organizationId,
          ),
        ),
      )
      .orderBy(desc(schema.agentScheduleTriggersTable.createdAt));
  }

  static async findAllEnabled(): Promise<ScheduleTrigger[]> {
    return await db
      .select()
      .from(schema.agentScheduleTriggersTable)
      .where(eq(schema.agentScheduleTriggersTable.enabled, true));
  }

  static async create(params: {
    agentId: string;
    organizationId: string;
    name: string;
    triggerType: "cron" | "interval" | "once";
    cronExpression?: string | null;
    intervalSeconds?: number | null;
    executeAt?: Date | null;
    timezone: string;
    inputMessage: string;
    enabled: boolean;
    misfireGraceSeconds: number;
    createdBy: string;
    nextExecuteAt?: Date | null;
  }): Promise<ScheduleTrigger> {
    const [trigger] = await db
      .insert(schema.agentScheduleTriggersTable)
      .values({
        agentId: params.agentId,
        organizationId: params.organizationId,
        name: params.name,
        triggerType: params.triggerType,
        cronExpression: params.cronExpression ?? null,
        intervalSeconds: params.intervalSeconds ?? null,
        executeAt: params.executeAt ?? null,
        timezone: params.timezone,
        inputMessage: params.inputMessage,
        enabled: params.enabled,
        misfireGraceSeconds: params.misfireGraceSeconds,
        createdBy: params.createdBy,
        nextExecuteAt: params.nextExecuteAt ?? null,
      })
      .returning();
    return trigger;
  }

  static async update(params: {
    id: string;
    organizationId: string;
    data: {
      name?: string;
      triggerType?: "cron" | "interval" | "once";
      cronExpression?: string | null;
      intervalSeconds?: number | null;
      executeAt?: Date | null;
      timezone?: string;
      inputMessage?: string;
      misfireGraceSeconds?: number;
      nextExecuteAt?: Date | null;
    };
  }): Promise<ScheduleTrigger | undefined> {
    const { id, organizationId, data } = params;
    const [trigger] = await db
      .update(schema.agentScheduleTriggersTable)
      .set(data)
      .where(
        and(
          eq(schema.agentScheduleTriggersTable.id, id),
          eq(
            schema.agentScheduleTriggersTable.organizationId,
            organizationId,
          ),
        ),
      )
      .returning();
    return trigger;
  }

  static async delete(params: {
    id: string;
    organizationId: string;
  }): Promise<boolean> {
    const { id, organizationId } = params;
    const result = await db
      .delete(schema.agentScheduleTriggersTable)
      .where(
        and(
          eq(schema.agentScheduleTriggersTable.id, id),
          eq(
            schema.agentScheduleTriggersTable.organizationId,
            organizationId,
          ),
        ),
      )
      .returning({ id: schema.agentScheduleTriggersTable.id });
    return result.length > 0;
  }

  static async setEnabled(params: {
    id: string;
    organizationId: string;
    enabled: boolean;
  }): Promise<ScheduleTrigger | undefined> {
    const { id, organizationId, enabled } = params;
    const [trigger] = await db
      .update(schema.agentScheduleTriggersTable)
      .set({ enabled })
      .where(
        and(
          eq(schema.agentScheduleTriggersTable.id, id),
          eq(
            schema.agentScheduleTriggersTable.organizationId,
            organizationId,
          ),
        ),
      )
      .returning();
    return trigger;
  }

  static async updateExecution(params: {
    id: string;
    lastExecutedAt: Date;
    nextExecuteAt: Date | null;
    lastStatus: ScheduleTriggerStatus;
    lastError: string | null;
  }): Promise<void> {
    const { id, lastExecutedAt, nextExecuteAt, lastStatus, lastError } =
      params;
    await db
      .update(schema.agentScheduleTriggersTable)
      .set({
        lastExecutedAt,
        nextExecuteAt,
        lastStatus,
        lastError,
        executionCount: sql`${schema.agentScheduleTriggersTable.executionCount} + 1`,
      })
      .where(eq(schema.agentScheduleTriggersTable.id, id));
  }

  static async disableOnceTriggersAfterExecution(id: string): Promise<void> {
    await db
      .update(schema.agentScheduleTriggersTable)
      .set({ enabled: false })
      .where(
        and(
          eq(schema.agentScheduleTriggersTable.id, id),
          eq(schema.agentScheduleTriggersTable.triggerType, "once"),
        ),
      );
  }
}

export default AgentScheduleTriggerModel;
