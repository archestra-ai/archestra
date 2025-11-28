import { and, eq, inArray } from "drizzle-orm";
import db, { schema } from "@/database";
import logger from "@/logging";

class AgentTeamModel {
  /**
   * Get all agent IDs that a user has access to (through team membership)
   */
  static async getUserAccessibleAgentIds(
    userId: string,
    isAgentAdmin: boolean,
  ): Promise<string[]> {
    // Agent admins have access to all agents
    if (isAgentAdmin) {
      const allAgents = await db
        .select({ id: schema.agentsTable.id })
        .from(schema.agentsTable);

      return allAgents.map((agent) => agent.id);
    }

    // Get all team IDs the user is a member of
    const userTeams = await db
      .select({ teamId: schema.teamMembersTable.teamId })
      .from(schema.teamMembersTable)
      .where(eq(schema.teamMembersTable.userId, userId));

    const teamIds = userTeams.map((t) => t.teamId);

    logger.info(
      {
        userId,
        isAgentAdmin,
        teamIds,
        teamCount: teamIds.length,
      },
      "getUserAccessibleAgentIds - checking team membership",
    );

    if (teamIds.length === 0) {
      logger.warn(
        { userId },
        "User has no team memberships - returning empty agent list",
      );
      return [];
    }

    // Get all agents assigned to these teams
    const agentTeams = await db
      .select({ agentId: schema.agentTeamsTable.agentId })
      .from(schema.agentTeamsTable)
      .where(inArray(schema.agentTeamsTable.teamId, teamIds));

    const accessibleAgentIds = agentTeams.map((at) => at.agentId);

    logger.info(
      {
        userId,
        teamIds,
        accessibleAgentIds,
        agentCount: accessibleAgentIds.length,
      },
      "getUserAccessibleAgentIds - final result",
    );

    return accessibleAgentIds;
  }

  /**
   * Check if a user has access to a specific agent (through team membership)
   */
  static async userHasAgentAccess(
    userId: string,
    agentId: string,
    isAgentAdmin: boolean,
  ): Promise<boolean> {
    // Agent admins have access to all agents
    if (isAgentAdmin) {
      return true;
    }

    // Get all team IDs the user is a member of
    const userTeams = await db
      .select({ teamId: schema.teamMembersTable.teamId })
      .from(schema.teamMembersTable)
      .where(eq(schema.teamMembersTable.userId, userId));

    const teamIds = userTeams.map((t) => t.teamId);

    if (teamIds.length === 0) {
      return false;
    }

    // Check if the agent is assigned to any of the user's teams
    const agentTeam = await db
      .select()
      .from(schema.agentTeamsTable)
      .where(
        and(
          eq(schema.agentTeamsTable.agentId, agentId),
          inArray(schema.agentTeamsTable.teamId, teamIds),
        ),
      )
      .limit(1);

    return agentTeam.length > 0;
  }

  /**
   * Get all team IDs assigned to a specific agent
   */
  static async getTeamsForAgent(agentId: string): Promise<string[]> {
    const agentTeams = await db
      .select({ teamId: schema.agentTeamsTable.teamId })
      .from(schema.agentTeamsTable)
      .where(eq(schema.agentTeamsTable.agentId, agentId));

    return agentTeams.map((at) => at.teamId);
  }

  /**
   * Sync team assignments for an agent (replaces all existing assignments)
   */
  static async syncAgentTeams(
    agentId: string,
    teamIds: string[],
  ): Promise<number> {
    await db.transaction(async (tx) => {
      // Delete all existing team assignments
      await tx
        .delete(schema.agentTeamsTable)
        .where(eq(schema.agentTeamsTable.agentId, agentId));

      // Insert new team assignments (if any teams provided)
      if (teamIds.length > 0) {
        await tx.insert(schema.agentTeamsTable).values(
          teamIds.map((teamId) => ({
            agentId,
            teamId,
          })),
        );
      }
    });

    return teamIds.length;
  }

  /**
   * Assign teams to an agent (idempotent)
   */
  static async assignTeamsToAgent(
    agentId: string,
    teamIds: string[],
  ): Promise<void> {
    if (teamIds.length === 0) return;

    await db
      .insert(schema.agentTeamsTable)
      .values(
        teamIds.map((teamId) => ({
          agentId,
          teamId,
        })),
      )
      .onConflictDoNothing();
  }

  /**
   * Remove a team assignment from an agent
   */
  static async removeTeamFromAgent(
    agentId: string,
    teamId: string,
  ): Promise<boolean> {
    const result = await db
      .delete(schema.agentTeamsTable)
      .where(
        and(
          eq(schema.agentTeamsTable.agentId, agentId),
          eq(schema.agentTeamsTable.teamId, teamId),
        ),
      );

    return result.rowCount !== null && result.rowCount > 0;
  }

  /**
   * Get team IDs for multiple agents in one query to avoid N+1
   */
  static async getTeamsForAgents(
    agentIds: string[],
  ): Promise<Map<string, string[]>> {
    if (agentIds.length === 0) {
      return new Map();
    }

    const agentTeams = await db
      .select({
        agentId: schema.agentTeamsTable.agentId,
        teamId: schema.agentTeamsTable.teamId,
      })
      .from(schema.agentTeamsTable)
      .where(inArray(schema.agentTeamsTable.agentId, agentIds));

    const teamsMap = new Map<string, string[]>();

    // Initialize all agent IDs with empty arrays
    for (const agentId of agentIds) {
      teamsMap.set(agentId, []);
    }

    // Populate the map with teams
    for (const { agentId, teamId } of agentTeams) {
      const teams = teamsMap.get(agentId) || [];
      teams.push(teamId);
      teamsMap.set(agentId, teams);
    }

    return teamsMap;
  }

  /**
   * Check if an agent and MCP server share any teams
   * Returns true if there's at least one team that both the agent and MCP server are assigned to
   */
  static async agentAndMcpServerShareTeam(
    agentId: string,
    mcpServerId: string,
  ): Promise<boolean> {
    const result = await db
      .select({ teamId: schema.agentTeamsTable.teamId })
      .from(schema.agentTeamsTable)
      .innerJoin(
        schema.mcpServerTeamsTable,
        eq(schema.agentTeamsTable.teamId, schema.mcpServerTeamsTable.teamId),
      )
      .where(
        and(
          eq(schema.agentTeamsTable.agentId, agentId),
          eq(schema.mcpServerTeamsTable.mcpServerId, mcpServerId),
        ),
      )
      .limit(1);

    return result.length > 0;
  }
}

export default AgentTeamModel;
