import { and, eq, getTableColumns, inArray } from "drizzle-orm";
import db, { schema } from "@/database";
import type { AgentTool, InsertAgentTool, UpdateAgentTool } from "@/types";
import AgentTeamModel from "./agent-team";

class AgentToolModel {
  static async create(
    agentId: string,
    toolId: string,
    options?: Partial<
      Pick<
        InsertAgentTool,
        | "allowUsageWhenUntrustedDataIsPresent"
        | "toolResultTreatment"
        | "responseModifierTemplate"
        | "credentialSourceMcpServerId"
        | "executionSourceMcpServerId"
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

  static async findAllAssignedToolIds(): Promise<string[]> {
    const results = await db
      .select({ toolId: schema.agentToolsTable.toolId })
      .from(schema.agentToolsTable);
    return [...new Set(results.map((r) => r.toolId))];
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

  static async createIfNotExists(
    agentId: string,
    toolId: string,
    credentialSourceMcpServerId?: string | null,
    executionSourceMcpServerId?: string | null,
  ) {
    const exists = await AgentToolModel.exists(agentId, toolId);
    if (!exists) {
      const options: Partial<
        Pick<
          InsertAgentTool,
          | "allowUsageWhenUntrustedDataIsPresent"
          | "toolResultTreatment"
          | "responseModifierTemplate"
          | "credentialSourceMcpServerId"
          | "executionSourceMcpServerId"
        >
      > = {};

      // Only include credentialSourceMcpServerId if it has a real value
      if (credentialSourceMcpServerId) {
        options.credentialSourceMcpServerId = credentialSourceMcpServerId;
      }

      // Only include executionSourceMcpServerId if it has a real value
      if (executionSourceMcpServerId) {
        options.executionSourceMcpServerId = executionSourceMcpServerId;
      }

      return await AgentToolModel.create(agentId, toolId, options);
    }
    return null;
  }

  static async update(
    id: string,
    data: Partial<
      Pick<
        UpdateAgentTool,
        | "allowUsageWhenUntrustedDataIsPresent"
        | "toolResultTreatment"
        | "responseModifierTemplate"
        | "credentialSourceMcpServerId"
        | "executionSourceMcpServerId"
      >
    >,
  ) {
    const [agentTool] = await db
      .update(schema.agentToolsTable)
      .set({
        ...data,
        updatedAt: new Date(),
      })
      .where(eq(schema.agentToolsTable.id, id))
      .returning();
    return agentTool;
  }

  static async findAll(
    userId?: string,
    isAdmin?: boolean,
  ): Promise<AgentTool[]> {
    // Get all agent-tool relationships with joined agent and tool details
    let query = db
      .select({
        ...getTableColumns(schema.agentToolsTable),
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
          catalogId: schema.toolsTable.catalogId,
          mcpServerId: schema.toolsTable.mcpServerId,
          mcpServerName: schema.mcpServersTable.name,
          mcpServerCatalogId: schema.mcpServersTable.catalogId,
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
      const accessibleAgentIds = await AgentTeamModel.getUserAccessibleAgentIds(
        userId,
        false,
      );

      if (accessibleAgentIds.length === 0) {
        return [];
      }

      query = query.where(
        inArray(schema.agentToolsTable.agentId, accessibleAgentIds),
      );
    }

    return query;
  }

  static async getSecurityConfig(
    agentId: string,
    toolName: string,
  ): Promise<{
    allowUsageWhenUntrustedDataIsPresent: boolean;
    toolResultTreatment: "trusted" | "sanitize_with_dual_llm" | "untrusted";
  } | null> {
    const [agentTool] = await db
      .select({
        allowUsageWhenUntrustedDataIsPresent:
          schema.agentToolsTable.allowUsageWhenUntrustedDataIsPresent,
        toolResultTreatment: schema.agentToolsTable.toolResultTreatment,
      })
      .from(schema.agentToolsTable)
      .innerJoin(
        schema.toolsTable,
        eq(schema.agentToolsTable.toolId, schema.toolsTable.id),
      )
      .where(
        and(
          eq(schema.agentToolsTable.agentId, agentId),
          eq(schema.toolsTable.name, toolName),
        ),
      );

    return agentTool || null;
  }

  /**
   * Clean up invalid credential sources when a user is removed from a team.
   * Sets credentialSourceMcpServerId to null for agent-tools where:
   * - The credential source is a personal token owned by the removed user
   * - The user no longer has access to the agent through any team
   */
  static async cleanupInvalidCredentialSourcesForUser(
    userId: string,
    teamId: string,
  ): Promise<number> {
    // Get all agents assigned to this team
    const agentsInTeam = await db
      .select({ agentId: schema.agentTeamTable.agentId })
      .from(schema.agentTeamTable)
      .where(eq(schema.agentTeamTable.teamId, teamId));

    if (agentsInTeam.length === 0) {
      return 0;
    }

    const agentIds = agentsInTeam.map((a) => a.agentId);

    // Get all personal MCP servers owned by this user
    const userPersonalServers = await db
      .select({ id: schema.mcpServersTable.id })
      .from(schema.mcpServersTable)
      .where(
        and(
          eq(schema.mcpServersTable.ownerId, userId),
          eq(schema.mcpServersTable.authType, "personal"),
        ),
      );

    if (userPersonalServers.length === 0) {
      return 0;
    }

    const serverIds = userPersonalServers.map((s) => s.id);

    // For each agent, check if user still has access through other teams
    let cleanedCount = 0;

    for (const agentId of agentIds) {
      // Check if user still has access to this agent through other teams
      const hasAccess = await AgentTeamModel.userHasAgentAccess(
        userId,
        agentId,
        false,
      );

      // If user no longer has access, clean up their personal tokens
      if (!hasAccess) {
        const result = await db
          .update(schema.agentToolsTable)
          .set({ credentialSourceMcpServerId: null })
          .where(
            and(
              eq(schema.agentToolsTable.agentId, agentId),
              inArray(
                schema.agentToolsTable.credentialSourceMcpServerId,
                serverIds,
              ),
            ),
          );

        cleanedCount += result.rowCount ?? 0;
      }
    }

    return cleanedCount;
  }
}

export default AgentToolModel;
