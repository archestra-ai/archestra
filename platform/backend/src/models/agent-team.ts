import { and, eq, inArray } from "drizzle-orm";
import db, { schema } from "@/database";

class AgentTeamModel {
  /**
   * Get all agent IDs that a user has access to (through team membership)
   */
  static async getUserAccessibleAgentIds(
    userId: string,
    isAdmin: boolean,
  ): Promise<string[]> {
    // Admins have access to all agents
    if (isAdmin) {
      const allAgents = await db
        .select({ id: schema.agentsTable.id })
        .from(schema.agentsTable);
      return allAgents.map((agent) => agent.id);
    }

    // Get all team IDs the user is a member of
    const userTeams = await db
      .select({ teamId: schema.teamMember.teamId })
      .from(schema.teamMember)
      .where(eq(schema.teamMember.userId, userId));

    const teamIds = userTeams.map((t) => t.teamId);

    if (teamIds.length === 0) {
      return [];
    }

    // Get all agents assigned to these teams
    const agentTeams = await db
      .select({ agentId: schema.agentTeamTable.agentId })
      .from(schema.agentTeamTable)
      .where(inArray(schema.agentTeamTable.teamId, teamIds));

    return agentTeams.map((at) => at.agentId);
  }

  /**
   * Check if a user has access to a specific agent (through team membership)
   */
  static async userHasAgentAccess(
    userId: string,
    agentId: string,
    isAdmin: boolean,
  ): Promise<boolean> {
    // Admins always have access
    if (isAdmin) {
      return true;
    }

    // Get all team IDs the user is a member of
    const userTeams = await db
      .select({ teamId: schema.teamMember.teamId })
      .from(schema.teamMember)
      .where(eq(schema.teamMember.userId, userId));

    const teamIds = userTeams.map((t) => t.teamId);

    if (teamIds.length === 0) {
      return false;
    }

    // Check if the agent is assigned to any of the user's teams
    const agentTeam = await db
      .select()
      .from(schema.agentTeamTable)
      .where(
        and(
          eq(schema.agentTeamTable.agentId, agentId),
          inArray(schema.agentTeamTable.teamId, teamIds),
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
      .select({ teamId: schema.agentTeamTable.teamId })
      .from(schema.agentTeamTable)
      .where(eq(schema.agentTeamTable.agentId, agentId));

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
        .delete(schema.agentTeamTable)
        .where(eq(schema.agentTeamTable.agentId, agentId));

      // Insert new team assignments (if any teams provided)
      if (teamIds.length > 0) {
        await tx.insert(schema.agentTeamTable).values(
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
      .insert(schema.agentTeamTable)
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
      .delete(schema.agentTeamTable)
      .where(
        and(
          eq(schema.agentTeamTable.agentId, agentId),
          eq(schema.agentTeamTable.teamId, teamId),
        ),
      );

    return result.rowCount !== null && result.rowCount > 0;
  }
}

export default AgentTeamModel;
