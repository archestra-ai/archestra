import { Cron } from "croner";
import { and, count, desc, eq, lte } from "drizzle-orm";
import db, { schema } from "@/database";
import type {
  InsertAgentScheduleTrigger,
  UpdateAgentScheduleTrigger,
} from "@/types";
import type { AgentScheduleTrigger } from "@/types";

class AgentScheduleTriggerModel {
  /**
   * Find all triggers for an organization
   */
  static async findByOrganization(params: {
    organizationId: string;
    limit?: number;
    offset?: number;
  }): Promise<AgentScheduleTrigger[]> {
    let query = db
      .select()
      .from(schema.agentScheduleTriggersTable)
      .where(
        eq(
          schema.agentScheduleTriggersTable.organizationId,
          params.organizationId,
        ),
      )
      .orderBy(desc(schema.agentScheduleTriggersTable.createdAt))
      .$dynamic();

    if (params.limit !== undefined) {
      query = query.limit(params.limit);
    }
    if (params.offset !== undefined) {
      query = query.offset(params.offset);
    }

    return await query;
  }

  /**
   * Find a trigger by ID
   */
  static async findById(id: string): Promise<AgentScheduleTrigger | null> {
    const [result] = await db
      .select()
      .from(schema.agentScheduleTriggersTable)
      .where(eq(schema.agentScheduleTriggersTable.id, id));

    return result ?? null;
  }

  /**
   * Create a new trigger
   */
  static async create(
    data: InsertAgentScheduleTrigger,
  ): Promise<AgentScheduleTrigger> {
    // Calculate initial nextRunAt based on cron expression
    const timezone = data.timezone ?? "UTC";
    const cron = new Cron(data.schedule, { timezone });
    const nextRun = cron.nextRun();

    const [result] = await db
      .insert(schema.agentScheduleTriggersTable)
      .values({
        ...data,
        nextRunAt: nextRun ?? undefined,
      })
      .returning();

    return result;
  }

  /**
   * Update a trigger
   */
  static async update(
    id: string,
    data: Partial<UpdateAgentScheduleTrigger>,
  ): Promise<AgentScheduleTrigger | null> {
    // Recalculate nextRunAt if schedule or timezone changed
    if (data.schedule !== undefined || data.timezone !== undefined) {
      const existing = await this.findById(id);
      if (!existing) return null;

      const schedule = data.schedule ?? existing.schedule;
      const timezone = data.timezone ?? existing.timezone ?? "UTC";
      const cron = new Cron(schedule, { timezone });
      const nextRun = cron.nextRun();

      const [result] = await db
        .update(schema.agentScheduleTriggersTable)
        .set({
          ...data,
          nextRunAt: nextRun ?? undefined,
        })
        .where(eq(schema.agentScheduleTriggersTable.id, id))
        .returning();

      return result ?? null;
    }

    const [result] = await db
      .update(schema.agentScheduleTriggersTable)
      .set(data)
      .where(eq(schema.agentScheduleTriggersTable.id, id))
      .returning();

    return result ?? null;
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

  /**
   * Find all enabled triggers
   */
  static async findAllEnabled(): Promise<AgentScheduleTrigger[]> {
    return await db
      .select()
      .from(schema.agentScheduleTriggersTable)
      .where(eq(schema.agentScheduleTriggersTable.enabled, true));
  }

  /**
   * Find triggers that are due for execution (nextRunAt <= now)
   * Uses FOR UPDATE SKIP LOCKED to prevent concurrent processing
   */
  static async findDueTriggers(): Promise<AgentScheduleTrigger[]> {
    const now = new Date();

    return await db
      .select()
      .from(schema.agentScheduleTriggersTable)
      .where(
        and(
          eq(schema.agentScheduleTriggersTable.enabled, true),
          lte(schema.agentScheduleTriggersTable.nextRunAt, now),
        ),
      );
  }

  /**
   * Update the last run timestamp and calculate next run
   */
  static async markExecuted(
    id: string,
    success: boolean,
  ): Promise<AgentScheduleTrigger | null> {
    const trigger = await this.findById(id);
    if (!trigger) return null;

    const timezone = trigger.timezone ?? "UTC";
    const cron = new Cron(trigger.schedule, { timezone });
    const nextRun = cron.nextRun();

    const [result] = await db
      .update(schema.agentScheduleTriggersTable)
      .set({
        lastRunAt: new Date(),
        nextRunAt: nextRun ?? undefined,
        consecutiveFailures: success ? false : true,
      })
      .where(eq(schema.agentScheduleTriggersTable.id, id))
      .returning();

    return result ?? null;
  }

  /**
   * Count triggers by organization
   */
  static async countByOrganization(organizationId: string): Promise<number> {
    const [result] = await db
      .select({ count: count() })
      .from(schema.agentScheduleTriggersTable)
      .where(
        eq(
          schema.agentScheduleTriggersTable.organizationId,
          organizationId,
        ),
      );

    return result?.count ?? 0;
  }
}

export default AgentScheduleTriggerModel;
