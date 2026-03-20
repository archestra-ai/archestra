import { and, eq, inArray } from "drizzle-orm";
import db, { schema } from "@/database";
import type {
  InsertAgentScheduleTrigger,
  SelectAgentScheduleTrigger,
  TriggerStatus,
} from "@/types";

export class AgentScheduleTriggerModel {
  /**
   * Create a new schedule trigger
   */
  static async create(
    data: InsertAgentScheduleTrigger,
  ): Promise<SelectAgentScheduleTrigger> {
    const [trigger] = await db
      .insert(schema.agentScheduleTriggersTable)
      .values(data)
      .returning();

    return trigger;
  }

  /**
   * Get a trigger by ID
   */
  static async findById(
    id: string,
  ): Promise<SelectAgentScheduleTrigger | undefined> {
    const [trigger] = await db
      .select()
      .from(schema.agentScheduleTriggersTable)
      .where(eq(schema.agentScheduleTriggersTable.id, id));

    return trigger;
  }

  /**
   * Get all triggers for a specific agent
   */
  static async findByAgentId(
    agentId: string,
  ): Promise<SelectAgentScheduleTrigger[]> {
    return db
      .select()
      .from(schema.agentScheduleTriggersTable)
      .where(eq(schema.agentScheduleTriggersTable.agentId, agentId));
  }

  /**
   * Get all enabled triggers across the system (used on startup)
   */
  static async findAllEnabled(): Promise<SelectAgentScheduleTrigger[]> {
    return db
      .select()
      .from(schema.agentScheduleTriggersTable)
      .where(eq(schema.agentScheduleTriggersTable.enabled, true));
  }

  /**
   * Update a trigger
   */
  static async update(
    id: string,
    data: Partial<Omit<InsertAgentScheduleTrigger, "id" | "agentId" | "organizationId" | "createdBy">>,
  ): Promise<SelectAgentScheduleTrigger> {
    const [updated] = await db
      .update(schema.agentScheduleTriggersTable)
      .set(data)
      .where(eq(schema.agentScheduleTriggersTable.id, id))
      .returning();

    return updated;
  }

  /**
   * Update trigger execution status after a run
   */
  static async recordExecution(
    id: string,
    params: {
      status: TriggerStatus;
      error?: string;
      nextExecuteAt?: Date | null;
    },
  ): Promise<SelectAgentScheduleTrigger> {
    // We increment execution_count using raw SQL for safety if needed,
    // but here we just fetch it first, or use a simpler approach.
    const trigger = await this.findById(id);
    if (!trigger) {
      throw new Error(`Trigger ${id} not found`);
    }

    const [updated] = await db
      .update(schema.agentScheduleTriggersTable)
      .set({
        lastExecutedAt: new Date(),
        lastStatus: params.status,
        lastError: params.error || null,
        nextExecuteAt: params.nextExecuteAt,
        executionCount: trigger.executionCount + 1,
      })
      .where(eq(schema.agentScheduleTriggersTable.id, id))
      .returning();

    return updated;
  }

  /**
   * Delete a trigger
   */
  static async delete(id: string): Promise<boolean> {
    const result = await db
      .delete(schema.agentScheduleTriggersTable)
      .where(eq(schema.agentScheduleTriggersTable.id, id));

    return result.rowCount !== null && result.rowCount > 0;
  }
}

export default AgentScheduleTriggerModel;
