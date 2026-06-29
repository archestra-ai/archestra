import { eq, sql } from "drizzle-orm";
import type { A2AProtocolTaskState } from "@/agents/a2a/a2a-protocol";
import db, { schema } from "@/database";
import type { A2ATask, InsertA2ATask } from "@/types";

class A2ATaskModel {
  private static async touchContext(contextId: string): Promise<void> {
    await db
      .update(schema.a2aContextsTable)
      .set({ updatedAt: new Date() })
      .where(eq(schema.a2aContextsTable.id, contextId));
  }

  static async create(data: InsertA2ATask): Promise<A2ATask> {
    const [task] = await db
      .insert(schema.a2aTasksTable)
      .values(data)
      .returning();

    await A2ATaskModel.touchContext(data.contextId);

    return task;
  }

  static async updateState(
    id: string,
    state: A2AProtocolTaskState,
  ): Promise<void> {
    await db
      .update(schema.a2aTasksTable)
      .set({ state, updatedAt: new Date() })
      .where(eq(schema.a2aTasksTable.id, id));
  }

  static async findById(id: string): Promise<A2ATask | null> {
    const [task] = await db
      .select()
      .from(schema.a2aTasksTable)
      .where(eq(schema.a2aTasksTable.id, id))
      .limit(1);

    return task ?? null;
  }

  static async delete(id: string): Promise<void> {
    await db
      .delete(schema.a2aTasksTable)
      .where(eq(schema.a2aTasksTable.id, id));
  }

  static async getTotalCount(): Promise<number> {
    const [{ count }] = await db
      .select({ count: sql<number>`count(${schema.a2aTasksTable.id})` })
      .from(schema.a2aTasksTable);

    return Number(count);
  }
}

export default A2ATaskModel;
