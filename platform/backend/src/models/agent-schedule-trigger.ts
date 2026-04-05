import { and, eq, sql } from "drizzle-orm";
import db, { schema, Transaction } from "@/database";
import type {
  AgentScheduleTrigger,
  InsertAgentScheduleTrigger,
  AgentScheduleRun,
  InsertAgentScheduleRun,
} from "@/types";

class AgentScheduleModel {
  static async createTrigger(
    data: InsertAgentScheduleTrigger,
    tx: Transaction = db as any,
  ): Promise<AgentScheduleTrigger> {
    const [result] = await tx
      .insert(schema.agentScheduleTriggersTable)
      .values(data)
      .returning();
    return result;
  }

  static async getTrigger(
    id: string,
    tx: Transaction = db as any,
  ): Promise<AgentScheduleTrigger | null> {
    const [result] = await tx
      .select()
      .from(schema.agentScheduleTriggersTable)
      .where(eq(schema.agentScheduleTriggersTable.id, id));
    return result ?? null;
  }

  static async listDueTriggers(
    tx: Transaction = db as any,
  ): Promise<AgentScheduleTrigger[]> {
    const now = new Date();
    return tx
      .select()
      .from(schema.agentScheduleTriggersTable)
      .where(
        and(
          eq(schema.agentScheduleTriggersTable.status, "active"),
          sql`${schema.agentScheduleTriggersTable.nextRunAt} <= ${now}`,
        ),
      );
  }

  /**
   * Acquire a transaction-level advisory lock for a specific trigger.
   * This ensures only one worker processes a given trigger at a time.
   * @param id The trigger UUID
   * @param tx The transaction object (required for advisory_xact_lock)
   * @returns True if the lock was acquired
   */
  static async acquireTriggerLock(
    id: string,
    tx: Transaction,
  ): Promise<boolean> {
    const LOCK_NAMESPACE = 0x51ed; // 'Sched' in hex
    const { rows } = await tx.execute<{ locked: boolean }>(sql`
      SELECT pg_try_advisory_xact_lock(${LOCK_NAMESPACE}, hashtext(${id})) AS locked
    `);
    return rows[0]?.locked ?? false;
  }

  static async updateTrigger(
    id: string,
    data: Partial<AgentScheduleTrigger>,
    tx: Transaction = db as any,
  ): Promise<AgentScheduleTrigger | null> {
    const [result] = await tx
      .update(schema.agentScheduleTriggersTable)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(schema.agentScheduleTriggersTable.id, id))
      .returning();
    return result ?? null;
  }

  static async createRun(
    data: InsertAgentScheduleRun,
    tx: Transaction = db as any,
  ): Promise<AgentScheduleRun> {
    const [result] = await tx
      .insert(schema.agentScheduleRunsTable)
      .values(data)
      .returning();
    return result;
  }

  static async updateRun(
    id: string,
    data: Partial<AgentScheduleRun>,
    tx: Transaction = db as any,
  ): Promise<AgentScheduleRun | null> {
    const [result] = await tx
      .update(schema.agentScheduleRunsTable)
      .set(data)
      .where(eq(schema.agentScheduleRunsTable.id, id))
      .returning();
    return result ?? null;
  }
}

export default AgentScheduleModel;
