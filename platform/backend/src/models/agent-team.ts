import { and, eq, inArray, isNull } from "drizzle-orm";
import db, { schema } from "@/database";
import logger from "@/logging";

class AgentTeamModel {
  /**
   * Get all agent IDs that a user has access to.
   */
  static async getUserAccessibleAgentIds(
    userId: string,
    isAgentAdmin: boolean,
  ): Promise<string[]> {
    logger.debug(
      { userId, isAgentAdmin },
      "AgentTeamModel.getUserAccessibleAgentIds: starting",
    );
    // Agent admins have access to all agents
    if (isAgentAdmin) {
      const allAgents = await db
        .select({ id: schema.agentsTable.id })
        .from(schema.agentsTable);

      logger.debug(
        { userId, count: allAgents.length },
        "AgentTeamModel.getUserAccessibleAgentIds: admin access to all agents",
      );
      return allAgents.map((agent) => agent.id);
    }

    // Get teamless agents (agents with no team assignments) — visible to all org members
    const teamlessAgents = await db
      .select({ id: schema.agentsTable.id })
      .from(schema.agentsTable)
      .leftJoin(
        schema.agentTeamsTable,
        eq(schema.agentsTable.id, schema.agentTeamsTable.agentId),
      )
      .where(isNull(schema.agentTeamsTable.agentId));
    const teamlessAgentIds = teamlessAgents.map((a) => a.id);

    // Get all team IDs the user is a member of
    const userTeams = await db
      .select({ teamId: schema.teamMembersTable.teamId })
      .from(schema.teamMembersTable)
      .where(eq(schema.teamMembersTable.userId, userId));

    const teamIds = userTeams.map((t) => t.teamId);

    logger.debug(
      { userId, teamCount: teamIds.length },
      "AgentTeamModel.getUserAccessibleAgentIds: found user teams",
    );

    if (teamIds.length === 0) {
      logger.debug(
        { userId, teamlessCount: teamlessAgentIds.length },
        "AgentTeamModel.getUserAccessibleAgentIds: user has no team memberships, returning teamless agents only",
      );
      return teamlessAgentIds;
    }

    // Get all agents assigned to these teams
    const agentTeams = await db
      .select({ agentId: schema.agentTeamsTable.agentId })
      .from(schema.agentTeamsTable)
      .where(inArray(schema.agentTeamsTable.teamId, teamIds));

    // Union team-scoped agents with teamless agents
    const accessibleSet = new Set([
      ...agentTeams.map((at) => at.agentId),
      ...teamlessAgentIds,
    ]);
    const accessibleAgentIds = [...accessibleSet];

    logger.debug(
      { userId, agentCount: accessibleAgentIds.length },
      "AgentTeamModel.getUserAccessibleAgentIds: completed",
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
    logger.debug(
      { userId, agentId, isAgentAdmin },
      "AgentTeamModel.userHasAgentAccess: checking access",
    );
    // Agent admins have access to all agents
    if (isAgentAdmin) {
      logger.debug(
        { userId, agentId },
        "AgentTeamModel.userHasAgentAccess: admin has access",
      );
      return true;
    }

    // Check if the agent has ANY team assignments — teamless agents are visible to all
    const agentTeamAssignments = await db
      .select({ teamId: schema.agentTeamsTable.teamId })
      .from(schema.agentTeamsTable)
      .where(eq(schema.agentTeamsTable.agentId, agentId))
      .limit(1);

    if (agentTeamAssignments.length === 0) {
      logger.debug(
        { userId, agentId },
        "AgentTeamModel.userHasAgentAccess: agent has no teams (org-wide), granting access",
      );
      return true;
    }

    // Get all team IDs the user is a member of
    const userTeams = await db
      .select({ teamId: schema.teamMembersTable.teamId })
      .from(schema.teamMembersTable)
      .where(eq(schema.teamMembersTable.userId, userId));

    const teamIds = userTeams.map((t) => t.teamId);

    if (teamIds.length === 0) {
      logger.debug(
        { userId, agentId },
        "AgentTeamModel.userHasAgentAccess: user has no teams",
      );
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

    const hasAccess = agentTeam.length > 0;
    logger.debug(
      { userId, agentId, hasAccess },
      "AgentTeamModel.userHasAgentAccess: completed",
    );
    return hasAccess;
  }

  /**
   * Get all team IDs assigned to a specific agent
   */
  static async getTeamsForAgent(agentId: string): Promise<string[]> {
    logger.debug(
      { agentId },
      "AgentTeamModel.getTeamsForAgent: fetching teams",
    );
    const agentTeams = await db
      .select({ teamId: schema.agentTeamsTable.teamId })
      .from(schema.agentTeamsTable)
      .where(eq(schema.agentTeamsTable.agentId, agentId));

    const teamIds = agentTeams.map((at) => at.teamId);
    logger.debug(
      { agentId, count: teamIds.length },
      "AgentTeamModel.getTeamsForAgent: completed",
    );
    return teamIds;
  }

  /**
   * Get team details (id and name) for a specific agent
   */
  static async getTeamDetailsForAgent(
    agentId: string,
  ): Promise<Array<{ id: string; name: string }>> {
    logger.debug(
      { agentId },
      "AgentTeamModel.getTeamDetailsForAgent: fetching team details",
    );
    const agentTeams = await db
      .select({
        teamId: schema.agentTeamsTable.teamId,
        teamName: schema.teamsTable.name,
      })
      .from(schema.agentTeamsTable)
      .innerJoin(
        schema.teamsTable,
        eq(schema.agentTeamsTable.teamId, schema.teamsTable.id),
      )
      .where(eq(schema.agentTeamsTable.agentId, agentId));

    const teams = agentTeams.map((at) => ({
      id: at.teamId,
      name: at.teamName,
    }));
    logger.debug(
      { agentId, count: teams.length },
      "AgentTeamModel.getTeamDetailsForAgent: completed",
    );
    return teams;
  }

  /**
   * Sync team assignments for an agent (replaces all existing assignments)
   */
  static async syncAgentTeams(
    agentId: string,
    teamIds: string[],
  ): Promise<number> {
    logger.debug(
      { agentId, teamCount: teamIds.length },
      "AgentTeamModel.syncAgentTeams: syncing teams",
    );
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

    logger.debug(
      { agentId, assignedCount: teamIds.length },
      "AgentTeamModel.syncAgentTeams: completed",
    );
    return teamIds.length;
  }

  /**
   * Assign teams to an agent (idempotent)
   */
  static async assignTeamsToAgent(
    agentId: string,
    teamIds: string[],
  ): Promise<void> {
    logger.debug(
      { agentId, teamCount: teamIds.length },
      "AgentTeamModel.assignTeamsToAgent: assigning teams",
    );
    if (teamIds.length === 0) {
      logger.debug(
        { agentId },
        "AgentTeamModel.assignTeamsToAgent: no teams to assign",
      );
      return;
    }

    await db
      .insert(schema.agentTeamsTable)
      .values(
        teamIds.map((teamId) => ({
          agentId,
          teamId,
        })),
      )
      .onConflictDoNothing();

    logger.debug({ agentId }, "AgentTeamModel.assignTeamsToAgent: completed");
  }

  /**
   * Remove a team assignment from an agent
   */
  static async removeTeamFromAgent(
    agentId: string,
    teamId: string,
  ): Promise<boolean> {
    logger.debug(
      { agentId, teamId },
      "AgentTeamModel.removeTeamFromAgent: removing team",
    );
    const result = await db
      .delete(schema.agentTeamsTable)
      .where(
        and(
          eq(schema.agentTeamsTable.agentId, agentId),
          eq(schema.agentTeamsTable.teamId, teamId),
        ),
      );

    const removed = result.rowCount !== null && result.rowCount > 0;
    logger.debug(
      { agentId, teamId, removed },
      "AgentTeamModel.removeTeamFromAgent: completed",
    );
    return removed;
  }

  /**
   * Check if a team token can access an agent.
   * Returns true if the agent is teamless (org-wide) or assigned to the given team.
   */
  static async teamHasAgentAccess(
    agentId: string,
    teamId: string | null,
  ): Promise<boolean> {
    logger.debug(
      { agentId, teamId },
      "AgentTeamModel.teamHasAgentAccess: checking access",
    );

    // Check if the agent has ANY team assignments — teamless agents are visible to all
    const agentTeamAssignments = await db
      .select({ teamId: schema.agentTeamsTable.teamId })
      .from(schema.agentTeamsTable)
      .where(eq(schema.agentTeamsTable.agentId, agentId))
      .limit(1);

    if (agentTeamAssignments.length === 0) {
      logger.debug(
        { agentId, teamId },
        "AgentTeamModel.teamHasAgentAccess: agent has no teams (org-wide), granting access",
      );
      return true;
    }

    if (!teamId) {
      logger.debug(
        { agentId },
        "AgentTeamModel.teamHasAgentAccess: no teamId provided, denying access",
      );
      return false;
    }

    // Check if the agent is assigned to this specific team
    const match = await db
      .select({ teamId: schema.agentTeamsTable.teamId })
      .from(schema.agentTeamsTable)
      .where(
        and(
          eq(schema.agentTeamsTable.agentId, agentId),
          eq(schema.agentTeamsTable.teamId, teamId),
        ),
      )
      .limit(1);

    const hasAccess = match.length > 0;
    logger.debug(
      { agentId, teamId, hasAccess },
      "AgentTeamModel.teamHasAgentAccess: completed",
    );
    return hasAccess;
  }

  /**
   * Get team IDs for multiple agents in one query to avoid N+1
   */
  static async getTeamsForAgents(
    agentIds: string[],
  ): Promise<Map<string, string[]>> {
    logger.debug(
      { agentCount: agentIds.length },
      "AgentTeamModel.getTeamsForAgents: fetching teams",
    );
    if (agentIds.length === 0) {
      logger.debug("AgentTeamModel.getTeamsForAgents: no agents provided");
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

    logger.debug(
      { agentCount: agentIds.length, assignmentCount: agentTeams.length },
      "AgentTeamModel.getTeamsForAgents: completed",
    );
    return teamsMap;
  }

  /**
   * Get team details (id and name) for multiple agents in one query to avoid N+1
   */
  static async getTeamDetailsForAgents(
    agentIds: string[],
  ): Promise<Map<string, Array<{ id: string; name: string }>>> {
    logger.debug(
      { agentCount: agentIds.length },
      "AgentTeamModel.getTeamDetailsForAgents: fetching team details",
    );
    if (agentIds.length === 0) {
      logger.debug(
        "AgentTeamModel.getTeamDetailsForAgents: no agents provided",
      );
      return new Map();
    }

    const agentTeams = await db
      .select({
        agentId: schema.agentTeamsTable.agentId,
        teamId: schema.agentTeamsTable.teamId,
        teamName: schema.teamsTable.name,
      })
      .from(schema.agentTeamsTable)
      .innerJoin(
        schema.teamsTable,
        eq(schema.agentTeamsTable.teamId, schema.teamsTable.id),
      )
      .where(inArray(schema.agentTeamsTable.agentId, agentIds));

    const teamsMap = new Map<string, Array<{ id: string; name: string }>>();

    // Initialize all agent IDs with empty arrays
    for (const agentId of agentIds) {
      teamsMap.set(agentId, []);
    }

    // Populate the map with team details
    for (const { agentId, teamId, teamName } of agentTeams) {
      const teams = teamsMap.get(agentId) || [];
      teams.push({ id: teamId, name: teamName });
      teamsMap.set(agentId, teams);
    }

    logger.debug(
      { agentCount: agentIds.length, assignmentCount: agentTeams.length },
      "AgentTeamModel.getTeamDetailsForAgents: completed",
    );
    return teamsMap;
  }
}

export default AgentTeamModel;
