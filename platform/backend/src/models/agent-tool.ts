import { and, eq } from "drizzle-orm";
import db, { schema } from "@/database";
import type { AgentTool, InsertAgentTool } from "@/types";

class AgentToolModel {
  static async create(
    agentId: string,
    toolId: string,
    options?: Partial<
      Pick<
        InsertAgentTool,
        "allowUsageWhenUntrustedDataIsPresent" | "toolResultTreatment"
      >
    >,
  ) {
    const [agentTool] = await db
      .insert(schema.agentToolsTable)
      .values({
        agentId,
        toolId,
        ...options,
      })
      .returning();
    return agentTool;
  }

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

  static async findToolIdsByAgent(agentId: string): Promise<string[]> {
    const results = await db
      .select({ toolId: schema.agentToolsTable.toolId })
      .from(schema.agentToolsTable)
      .where(eq(schema.agentToolsTable.agentId, agentId));
    return results.map((r) => r.toolId);
  }

  static async findAgentIdsByTool(toolId: string): Promise<string[]> {
    const results = await db
      .select({ agentId: schema.agentToolsTable.agentId })
      .from(schema.agentToolsTable)
      .where(eq(schema.agentToolsTable.toolId, toolId));
    return results.map((r) => r.agentId);
  }

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

  static async createIfNotExists(agentId: string, toolId: string) {
    const exists = await AgentToolModel.exists(agentId, toolId);
    if (!exists) {
      return await AgentToolModel.create(agentId, toolId);
    }
    return null;
  }

  static async findAll(
    userId?: string,
    isAdmin?: boolean,
  ): Promise<AgentTool[]> {
    // Get all agent-tool relationships with joined agent and tool details
    const query = db
      .select({
        id: schema.agentToolsTable.id,
        allowUsageWhenUntrustedDataIsPresent:
          schema.agentToolsTable.allowUsageWhenUntrustedDataIsPresent,
        toolResultTreatment: schema.agentToolsTable.toolResultTreatment,
        createdAt: schema.agentToolsTable.createdAt,
        updatedAt: schema.agentToolsTable.updatedAt,
        agent: {
          id: schema.agentsTable.id,
          name: schema.agentsTable.name,
        },
        tool: {
          id: schema.toolsTable.id,
          name: schema.toolsTable.name,
          description: schema.toolsTable.description,
          parameters: schema.toolsTable.parameters,
          createdAt: schema.toolsTable.createdAt,
          updatedAt: schema.toolsTable.updatedAt,
          mcpServer: {
            id: schema.mcpServersTable.id,
            name: schema.mcpServersTable.name,
          },
        },
      })
      .from(schema.agentToolsTable)
      .innerJoin(
        schema.agentsTable,
        eq(schema.agentToolsTable.agentId, schema.agentsTable.id),
      )
      .innerJoin(
        schema.toolsTable,
        eq(schema.agentToolsTable.toolId, schema.toolsTable.id),
      )
      .leftJoin(
        schema.mcpServersTable,
        eq(schema.toolsTable.mcpServerId, schema.mcpServersTable.id),
      )
      .$dynamic();

    // Apply access control filtering for non-admins if needed
    if (userId && !isAdmin) {
      // Add access control logic here if needed
      // For now, show all agent-tool relationships
    }

    return query;
  }
}

export default AgentToolModel;
