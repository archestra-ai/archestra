import { and, eq, lte } from "drizzle-orm";
import { Cron } from "croner";
import db, { schema } from "@/database";
import logger from "@/logging";
import type { AgentSchedule, UpdateAgentSchedule } from "@/types";

class AgentScheduleModel {
  /**
   * Find all schedules that are currently enabled.
   */
  static async findAllEnabled(): Promise<AgentSchedule[]> {
    return await db
      .select()
      .from(schema.agentSchedulesTable)
      .where(eq(schema.agentSchedulesTable.enabled, true));
  }

  /**
   * Find all enabled schedules that are due for execution (nextRunAt <= now).
   */
  static async findDue(): Promise<AgentSchedule[]> {
    const now = new Date();
    return await db
      .select()
      .from(schema.agentSchedulesTable)
      .where(
        and(
          eq(schema.agentSchedulesTable.enabled, true),
          lte(schema.agentSchedulesTable.nextRunAt, now)
        )
      );
  }

  /**
   * Update a specific agent schedule by its ID.
   */
  static async update(id: string, data: UpdateAgentSchedule): Promise<AgentSchedule | null> {
    const [updated] = await db
      .update(schema.agentSchedulesTable)
      .set(data)
      .where(eq(schema.agentSchedulesTable.id, id))
      .returning();
    return updated || null;
  }

  /**
   * Recalculate and update the next run time for a schedule using the cron string.
   */
  static async updateNextRun(id: string, cronStr: string, lastRunAt: Date): Promise<void> {
    try {
      const cron = new Cron(cronStr);
      const nextRunAt = cron.next(lastRunAt);
      if (nextRunAt) {
        await this.update(id, { nextRunAt, lastRunAt });
      }
    } catch (error) {
      logger.error(
        { id, cronStr, error: error instanceof Error ? error.message : String(error) },
        "Failed to update next run for agent schedule"
      );
    }
  }

  /**
   * Find all schedules associated with a specific agent.
   */
  static async findByAgentId(agentId: string): Promise<AgentSchedule[]> {
    return await db
      .select()
      .from(schema.agentSchedulesTable)
      .where(eq(schema.agentSchedulesTable.agentId, agentId));
  }
}

export default AgentScheduleModel;
