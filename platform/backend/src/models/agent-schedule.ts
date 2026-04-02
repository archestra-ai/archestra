import { and, eq } from "drizzle-orm";
import db, { schema } from "@/database";
import { validateCronExpression } from "@/database/schemas/agent-schedule";

export type AgentSchedule = typeof schema.agentSchedulesTable.$inferSelect;
export type InsertAgentSchedule = typeof schema.agentSchedulesTable.$inferInsert;

const AgentScheduleModel = {
  /**
   * Returns all enabled agent schedules.
   * Called every minute by the scheduler task.
   */
  async findAllEnabled(): Promise<AgentSchedule[]> {
    return db
      .select()
      .from(schema.agentSchedulesTable)
      .where(eq(schema.agentSchedulesTable.enabled, true));
  },

  /**
   * Creates a new agent schedule after validating the cron expression.
   * Throws if the cron is malformed (hardens the DB).
   */
  async create(data: InsertAgentSchedule): Promise<AgentSchedule> {
    validateCronExpression(data.cron);
    const [row] = await db
      .insert(schema.agentSchedulesTable)
      .values(data)
      .returning();
    return row;
  },

  /**
   * Updates an existing schedule, re-validating the cron if changed.
   */
  async update(
    id: string,
    data: Partial<InsertAgentSchedule>,
  ): Promise<AgentSchedule | null> {
    if (data.cron !== undefined) {
      validateCronExpression(data.cron);
    }
    const [row] = await db
      .update(schema.agentSchedulesTable)
      .set(data)
      .where(eq(schema.agentSchedulesTable.id, id))
      .returning();
    return row ?? null;
  },

  /** Hard-deletes a schedule (CASCADE deletes cover agent removal). */
  async delete(id: string): Promise<void> {
    await db
      .delete(schema.agentSchedulesTable)
      .where(eq(schema.agentSchedulesTable.id, id));
  },

  /** Returns all schedules for a given agent (for management APIs). */
  async findByAgentId(agentId: string): Promise<AgentSchedule[]> {
    return db
      .select()
      .from(schema.agentSchedulesTable)
      .where(eq(schema.agentSchedulesTable.agentId, agentId));
  },

  /**
   * Updates `lastRunAt` for a schedule after a successful trigger.
   * Called by the run handler to advance the cron baseline.
   */
  async markRan(id: string, ranAt: Date): Promise<void> {
    await db
      .update(schema.agentSchedulesTable)
      .set({ lastRunAt: ranAt })
      .where(eq(schema.agentSchedulesTable.id, id));
  },

  /** Find a single schedule by id. */
  async findById(id: string): Promise<AgentSchedule | null> {
    const [row] = await db
      .select()
      .from(schema.agentSchedulesTable)
      .where(eq(schema.agentSchedulesTable.id, id));
    return row ?? null;
  },
};

export default AgentScheduleModel;
