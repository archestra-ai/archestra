import { and, eq, inArray, sql } from "drizzle-orm";
import db, { schema } from "@/database";
import logger from "@/logging";

class AgentTeamModel {
  /**
   * Get all agent IDs that a user has access to.
   * Three sources of access:
   * 1. Org-scoped agents (visible to all)
   * 2. Author's own personal agents
   * 3. Team-scoped agents where user is a team member
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

    // Single query: UNION of org-scoped, author's own, and team-scoped agents
    const result = await db.execute<{ id: string }>(sql`
      SELECT id FROM agents WHERE scope = 'org'
      UNION
      SELECT id FROM agents WHERE author_id = ${userId} AND scope = 'personal'
      UNION
      SELECT at.agent_id AS id
        FROM agent_team at
        INNER JOIN agents a ON at.agent_id = a.id
        INNER JOIN team_member tm ON at.team_id = tm.team_id
        WHERE tm.user_id = ${userId} AND a.scope = 'team'
    `);

    const accessibleAgentIds = result.rows.map((r) => r.id);

    logger.debug(
      { userId, agentCount: accessibleAgentIds.length },
      "AgentTeamModel.getUserAccessibleAgentIds: completed",
    );
    return accessibleAgentIds;
  }

  /**
   * Check if a user has access to a specific agent.
   * Access rules (in order):
   * 1. Admin → true
   * 2. scope = 'org' → true
   * 3. scope = 'personal' → only the author has access
   * 4. scope = 'team' AND user is in one of agent's teams → true
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
    // 1. Admin → true
    if (isAgentAdmin) {
      logger.debug(
        { userId, agentId },
        "AgentTeamModel.userHasAgentAccess: admin has access",
      );
      return true;
    }

    // Fetch agent's scope and authorId
    const [agent] = await db
      .select({
        scope: schema.agentsTable.scope,
        authorId: schema.agentsTable.authorId,
      })
      .from(schema.agentsTable)
      .where(eq(schema.agentsTable.id, agentId))
      .limit(1);

    if (!agent) {
      return false;
    }

    // 2. scope = 'org' → true
    if (agent.scope === "org") {
      logger.debug(
        { userId, agentId },
        "AgentTeamModel.userHasAgentAccess: org-scoped agent, granting access",
      );
      return true;
    }

    // 3. scope = 'personal' → only the author has access
    if (agent.scope === "personal") {
      const hasAccess = agent.authorId === userId;
      logger.debug(
        { userId, agentId, hasAccess },
        "AgentTeamModel.userHasAgentAccess: personal agent check",
      );
      return hasAccess;
    }

    // 4. scope = 'team' AND user is in one of agent's teams
    if (agent.scope === "team") {
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
        "AgentTeamModel.userHasAgentAccess: team check completed",
      );
      return hasAccess;
    }

    return false;
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
   * Access rules:
   * 1. scope = 'org' → true
   * 2. scope = 'team' AND agent assigned to the given team → true
   * 3. Otherwise → false (personal agents NOT accessible via team tokens)
   */
  static async teamHasAgentAccess(
    agentId: string,
    teamId: string | null,
  ): Promise<boolean> {
    logger.debug(
      { agentId, teamId },
      "AgentTeamModel.teamHasAgentAccess: checking access",
    );

    // Fetch agent's scope
    const [agent] = await db
      .select({ scope: schema.agentsTable.scope })
      .from(schema.agentsTable)
      .where(eq(schema.agentsTable.id, agentId))
      .limit(1);

    if (!agent) {
      return false;
    }

    // 1. scope = 'org' → true
    if (agent.scope === "org") {
      logger.debug(
        { agentId, teamId },
        "AgentTeamModel.teamHasAgentAccess: org-scoped agent, granting access",
      );
      return true;
    }

    // 2. scope = 'team' AND agent assigned to the given team
    if (agent.scope === "team" && teamId) {
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
        "AgentTeamModel.teamHasAgentAccess: team check completed",
      );
      return hasAccess;
    }

    // 3. Personal agents or no teamId → false
    logger.debug(
      { agentId, teamId },
      "AgentTeamModel.teamHasAgentAccess: denying access",
    );
    return false;
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
