import { desc, eq } from "drizzle-orm";
import db, { schema } from "@/database";
import type { DualLlmResult, InsertDualLlmResult } from "@/types";

class DualLlmResultModel {
  static async create(data: InsertDualLlmResult): Promise<DualLlmResult> {
    const [result] = await db
      .insert(schema.dualLlmResultsTable)
      .values(data)
      .returning();

    return result;
  }

  static async findByToolCallId(
    toolCallId: string,
  ): Promise<DualLlmResult | null> {
    const [result] = await db
      .select()
      .from(schema.dualLlmResultsTable)
      .where(eq(schema.dualLlmResultsTable.toolCallId, toolCallId));

    return result || null;
  }

  static async findByAgentId(agentId: string): Promise<DualLlmResult[]> {
    return db
      .select()
      .from(schema.dualLlmResultsTable)
      .where(eq(schema.dualLlmResultsTable.agentId, agentId))
      .orderBy(desc(schema.dualLlmResultsTable.createdAt));
  }

  static async findAll(): Promise<DualLlmResult[]> {
    return db
      .select()
      .from(schema.dualLlmResultsTable)
      .orderBy(desc(schema.dualLlmResultsTable.createdAt));
  }
}

export default DualLlmResultModel;
