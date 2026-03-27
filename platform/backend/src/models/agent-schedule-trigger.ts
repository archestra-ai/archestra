import { and, eq, lte, sql } from "drizzle-orm";
import db, { schema } from "@/database";
import type {
  AgentScheduleTrigger,
  InsertAgentScheduleTrigger,
  UpdateAgentScheduleTrigger,
} from "@/types";

class AgentScheduleTriggerModel {
  static async create(
    data: InsertAgentScheduleTrigger,
  ): Promise<AgentScheduleTrigger> {
    const [result] = await db
      .insert(schema.agentScheduleTriggersTable)
      .values(data)
      .returning();
    return result;
  }

  static async findById(id: string): Promise<AgentScheduleTrigger | null> {
    const [result] = await db
      .select()
      .from(schema.agentScheduleTriggersTable)
      .where(eq(schema.agentScheduleTriggersTable.id, id))
      .limit(1);
    return result ?? null;
  }

  static async findByIdAndOrg(params: {
    id: string;
    organizationId: string;
  }): Promise<AgentScheduleTrigger | null> {
    const [result] = await db
      .select()
      .from(schema.agentScheduleTriggersTable)
      .where(
        and(
          eq(schema.agentScheduleTriggersTable.id, params.id),
          eq(
            schema.agentScheduleTriggersTable.organizationId,
            params.organizationId,
          ),
        ),
      )
      .limit(1);
    return result ?? null;
  }

  static async findByAgentId(agentId: string): Promise<AgentScheduleTrigger[]> {
    return db
      .select()
      .from(schema.agentScheduleTriggersTable)
      .where(eq(schema.agentScheduleTriggersTable.agentId, agentId))
      .orderBy(schema.agentScheduleTriggersTable.createdAt);
  }

  static async findByOrganization(
    organizationId: string,
  ): Promise<AgentScheduleTrigger[]> {
    return db
      .select()
      .from(schema.agentScheduleTriggersTable)
      .where(
        eq(schema.agentScheduleTriggersTable.organizationId, organizationId),
      )
      .orderBy(schema.agentScheduleTriggersTable.createdAt);
  }

  static async findDueTriggers(): Promise<AgentScheduleTrigger[]> {
    return db
      .select()
      .from(schema.agentScheduleTriggersTable)
      .where(
        and(
          eq(schema.agentScheduleTriggersTable.enabled, true),
          lte(schema.agentScheduleTriggersTable.nextExecutionAt, new Date()),
        ),
      );
  }

  static async update(
    id: string,
    data: UpdateAgentScheduleTrigger,
  ): Promise<AgentScheduleTrigger | null> {
    const [result] = await db
      .update(schema.agentScheduleTriggersTable)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(schema.agentScheduleTriggersTable.id, id))
      .returning();
    return result ?? null;
  }

  static async markExecuted(params: {
    id: string;
    nextExecutionAt: Date | null;
    error?: string;
  }): Promise<void> {
    await db
      .update(schema.agentScheduleTriggersTable)
      .set({
        lastExecutedAt: new Date(),
        nextExecutionAt: params.nextExecutionAt,
        executionCount: sql`${schema.agentScheduleTriggersTable.executionCount} + 1`,
        lastError: params.error ?? null,
        updatedAt: new Date(),
        ...(params.nextExecutionAt === null ? { enabled: false } : {}),
      })
      .where(eq(schema.agentScheduleTriggersTable.id, params.id));
  }

  static async delete(id: string): Promise<boolean> {
    const result = await db
      .delete(schema.agentScheduleTriggersTable)
      .where(eq(schema.agentScheduleTriggersTable.id, id))
      .returning({ id: schema.agentScheduleTriggersTable.id });
    return result.length > 0;
  }
}

export default AgentScheduleTriggerModel;
