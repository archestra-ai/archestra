import { asc, eq } from "drizzle-orm";
import db, { schema } from "@/database";
import type { AgentExecutionInput, InsertAgentExecutionInput } from "@/types";
import { normalizeByteaField } from "@/utils/normalize-bytea";

/** Durable inputs for a task, available again if another control plane adopts it. */
class AgentExecutionInputModel {
  static async createMany(
    inputs: InsertAgentExecutionInput[],
  ): Promise<AgentExecutionInput[]> {
    if (inputs.length === 0) return [];
    const rows = await db
      .insert(schema.agentExecutionInputsTable)
      .values(inputs)
      .onConflictDoNothing({
        target: [
          schema.agentExecutionInputsTable.taskId,
          schema.agentExecutionInputsTable.runtimePath,
        ],
      })
      .returning();
    if (rows.length === inputs.length) {
      return rows.map((row) => normalizeByteaField(row, "fileData"));
    }
    return AgentExecutionInputModel.findByTaskId(inputs[0].taskId);
  }

  static async findByTaskId(taskId: string): Promise<AgentExecutionInput[]> {
    const rows = await db
      .select()
      .from(schema.agentExecutionInputsTable)
      .where(eq(schema.agentExecutionInputsTable.taskId, taskId))
      .orderBy(
        asc(schema.agentExecutionInputsTable.createdAt),
        asc(schema.agentExecutionInputsTable.id),
      );
    return rows.map((row) => normalizeByteaField(row, "fileData"));
  }
}

export default AgentExecutionInputModel;
