import { asc, eq } from "drizzle-orm";
import db, { schema } from "@/database";
import type { AgentRunInput, InsertAgentRunInput } from "@/types";
import { normalizeByteaField } from "@/utils/normalize-bytea";

/** Durable inputs for a task, available again if another control plane adopts it. */
class AgentRunInputModel {
  static async createMany(
    inputs: InsertAgentRunInput[],
  ): Promise<AgentRunInput[]> {
    if (inputs.length === 0) return [];
    const rows = await db
      .insert(schema.agentRunInputsTable)
      .values(inputs)
      .onConflictDoNothing({
        target: [
          schema.agentRunInputsTable.taskId,
          schema.agentRunInputsTable.runtimePath,
        ],
      })
      .returning();
    if (rows.length === inputs.length) {
      return rows.map((row) => normalizeByteaField(row, "fileData"));
    }
    return AgentRunInputModel.findByTaskId(inputs[0].taskId);
  }

  static async findByTaskId(taskId: string): Promise<AgentRunInput[]> {
    const rows = await db
      .select()
      .from(schema.agentRunInputsTable)
      .where(eq(schema.agentRunInputsTable.taskId, taskId))
      .orderBy(
        asc(schema.agentRunInputsTable.createdAt),
        asc(schema.agentRunInputsTable.id),
      );
    return rows.map((row) => normalizeByteaField(row, "fileData"));
  }
}

export default AgentRunInputModel;
