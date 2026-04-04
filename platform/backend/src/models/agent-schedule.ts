import { and, eq, lte } from "drizzle-orm";
import db, { schema } from "@/database";
import type { AgentSchedule, InsertAgentSchedule, UpdateAgentSchedule } from "@/types";

class AgentScheduleModel {
  static async create(data: InsertAgentSchedule): Promise<AgentSchedule> {
    const [created] = await db
      .insert(schema.agentSchedulesTable)
      .values(data)
      .returning();
    return created;
  }

  static async update(id: string, data: UpdateAgentSchedule): Promise<AgentSchedule | null> {
    const [updated] = await db
      .update(schema.agentSchedulesTable)
      .set(data)
      .where(eq(schema.agentSchedulesTable.id, id))
      .returning();
    return updated || null;
  }

  static async delete(id: string): Promise<void> {
    await db
      .delete(schema.agentSchedulesTable)
      .where(eq(schema.agentSchedulesTable.id, id));
  }

  static async findById(id: string): Promise<AgentSchedule | null> {
    const [schedule] = await db
      .select()
      .from(schema.agentSchedulesTable)
      .where(eq(schema.agentSchedulesTable.id, id));
    return schedule || null;
  }

  static async findAllByAgentId(agentId?: string): Promise<AgentSchedule[]> {
    let query = db.select().from(schema.agentSchedulesTable).$dynamic();
    if (agentId) {
      query = query.where(eq(schema.agentSchedulesTable.agentId, agentId));
    }
    return await query;
  }

  static async findAllDue(): Promise<AgentSchedule[]> {
    return await db
      .select()
      .from(schema.agentSchedulesTable)
      .where(
        and(
          eq(schema.agentSchedulesTable.isActive, true),
          lte(schema.agentSchedulesTable.nextRunAt, new Date()),
        )
      );
  }
}

export default AgentScheduleModel;
