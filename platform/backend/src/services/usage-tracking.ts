import { and, eq, inArray, sql } from "drizzle-orm";
import db, { schema } from "@/database";
import { AgentTeamModel, LimitModel } from "@/models";
import type { InsertInteraction } from "@/types";

/**
 * Service for tracking and updating usage in limits table when interactions are created
 */
class UsageTrackingService {
  /**
   * Update usage limits after an interaction is created
   */
  static async updateUsageAfterInteraction(
    interaction: InsertInteraction & { id: string },
  ): Promise<void> {
    try {
      // Calculate token usage for this interaction
      const inputTokens = interaction.inputTokens || 0;
      const outputTokens = interaction.outputTokens || 0;

      if (inputTokens === 0 && outputTokens === 0) {
        // No tokens used, nothing to update
        return;
      }

      // Get agent's teams to update team and organization limits
      const agentTeamIds = await AgentTeamModel.getTeamsForAgent(
        interaction.agentId,
      );

      const updatePromises: Promise<void>[] = [];

      if (agentTeamIds.length === 0) {
        console.warn(
          `Agent ${interaction.agentId} has no team assignments for interaction ${interaction.id}`,
        );

        // Even if agent has no teams, we should still try to update organization limits
        // We'll use a default organization approach - get the first organization from existing limits
        try {
          const existingOrgLimits = await db
            .select({ entityId: schema.limitsTable.entityId })
            .from(schema.limitsTable)
            .where(eq(schema.limitsTable.entityType, "organization"))
            .limit(1);

          if (existingOrgLimits.length > 0) {
            updatePromises.push(
              LimitModel.updateTokenLimitUsage(
                "organization",
                existingOrgLimits[0].entityId,
                inputTokens,
                outputTokens,
              ),
            );
          }
        } catch (error) {
          console.error(
            "Failed to find organization for agent with no teams:",
            error,
          );
        }
      } else {
        // Get team details to access organizationId
        const teams = await db
          .select()
          .from(schema.teamsTable)
          .where(inArray(schema.teamsTable.id, agentTeamIds));

        // Update organization-level token cost limits (from first team's organization)
        if (teams.length > 0 && teams[0].organizationId) {
          updatePromises.push(
            LimitModel.updateTokenLimitUsage(
              "organization",
              teams[0].organizationId,
              inputTokens,
              outputTokens,
            ),
          );
        }

        // Update team-level token cost limits
        for (const team of teams) {
          updatePromises.push(
            LimitModel.updateTokenLimitUsage(
              "team",
              team.id,
              inputTokens,
              outputTokens,
            ),
          );
        }
      }

      // Update agent-level token cost limits (if any exist)
      updatePromises.push(
        LimitModel.updateTokenLimitUsage(
          "agent",
          interaction.agentId,
          inputTokens,
          outputTokens,
        ),
      );

      // Execute all updates in parallel
      await Promise.all(updatePromises);
    } catch (error) {
      console.error("Error updating usage limits after interaction:", error);
      // Don't throw - usage tracking should not break interaction creation
    }
  }

  /**
   * Update MCP server call usage (for future use)
   */
  static async updateMcpServerCallUsage(
    entityType: "organization" | "team" | "agent",
    entityId: string,
    mcpServerName: string,
  ): Promise<void> {
    try {
      // For MCP calls, we'll use currentUsageTokensIn to track call count
      // (currentUsageTokensOut can remain 0 for MCP calls)
      await db
        .update(schema.limitsTable)
        .set({
          currentUsageTokensIn: sql`${schema.limitsTable.currentUsageTokensIn} + 1`,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(schema.limitsTable.entityType, entityType),
            eq(schema.limitsTable.entityId, entityId),
            eq(schema.limitsTable.limitType, "mcp_server_calls"),
            eq(schema.limitsTable.mcpServerName, mcpServerName),
          ),
        );
    } catch (error) {
      console.error(
        `Error updating MCP server call usage for ${entityId}:`,
        error,
      );
    }
  }
}

export default UsageTrackingService;
