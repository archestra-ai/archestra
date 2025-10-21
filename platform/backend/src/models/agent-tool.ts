import { and, eq } from "drizzle-orm";
import db, { schema } from "@/database";
import type { InsertAgentTool } from "@/types";

class AgentToolModel {
  /**
   * Create a new agent-tool relationship
   */
  static async create(agentId: string, toolId: string) {
    const [agentTool] = await db
      .insert(schema.agentToolsTable)
      .values({ agentId, toolId })
      .returning();
    return agentTool;
  }

  /**
   * Delete an agent-tool relationship
   */
  static async delete(agentId: string, toolId: string): Promise<boolean> {
    const result = await db
      .delete(schema.agentToolsTable)
      .where(
        and(
          eq(schema.agentToolsTable.agentId, agentId),
          eq(schema.agentToolsTable.toolId, toolId),
        ),
      );
    return result.rowCount !== null && result.rowCount > 0;
  }

  /**
   * Get all tool IDs assigned to an agent
   */
  static async findToolIdsByAgent(agentId: string): Promise<string[]> {
    const results = await db
      .select({ toolId: schema.agentToolsTable.toolId })
      .from(schema.agentToolsTable)
      .where(eq(schema.agentToolsTable.agentId, agentId));
    return results.map((r) => r.toolId);
  }

  /**
   * Get all agent IDs that a tool is assigned to
   */
  static async findAgentIdsByTool(toolId: string): Promise<string[]> {
    const results = await db
      .select({ agentId: schema.agentToolsTable.agentId })
      .from(schema.agentToolsTable)
      .where(eq(schema.agentToolsTable.toolId, toolId));
    return results.map((r) => r.agentId);
  }

  /**
   * Check if a tool is assigned to an agent
   */
  static async exists(agentId: string, toolId: string): Promise<boolean> {
    const [result] = await db
      .select()
      .from(schema.agentToolsTable)
      .where(
        and(
          eq(schema.agentToolsTable.agentId, agentId),
          eq(schema.agentToolsTable.toolId, toolId),
        ),
      )
      .limit(1);
    return !!result;
  }
}

export default AgentToolModel;
