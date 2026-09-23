// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import type { ScopedResource } from "@archestra/shared";
import {
  and,
  eq,
  inArray,
  isNull,
  or,
  type SQL,
  type SQLWrapper,
  sql,
} from "drizzle-orm";
import db, { schema, withDbTransaction } from "@/database";
import logger from "@/logging";
import type { AgentAccessContext, LabelWithDetails } from "@/types";
import AgentModel from "./agent";
import { findAgentAccessContextById } from "./agent-access-context";
import ResourcePermissionPolicyModel from "./resource-permission-policy";
import TeamLabelModel from "./team-label";

class AgentTeamModel {
  static async credentialHasAgentAccess(params: {
    organizationId: string;
    agentId: string;
    teamId: string | null;
  }): Promise<boolean> {
    const [agent] = await db
      .select({
        agentType: schema.agentsTable.agentType,
        organizationId: schema.agentsTable.organizationId,
      })
      .from(schema.agentsTable)
      .where(
        and(
          eq(schema.agentsTable.id, params.agentId),
          isNull(schema.agentsTable.deletedAt),
        ),
      );
    if (!agent || agent.organizationId !== params.organizationId) return false;
    const resource = agent.agentType === "mcp_gateway" ? "mcpGateway" : "agent";
    const key = {
      organizationId: params.organizationId,
      resource,
      scope: params.agentId,
    } as const;
    return ResourcePermissionPolicyModel.sharedCredentialHasAccess({
      ...key,
      teamId: params.teamId,
      action: "use",
    });
  }

  /** Get all agent IDs that a user can read. */
  static async getUserAccessibleAgentIds(
    userId: string,
    isAgentAdmin: boolean,
  ): Promise<string[]> {
    logger.debug(
      { userId, isAgentAdmin },
      "AgentTeamModel.getUserAccessibleAgentIds: starting",
    );
    const accessibleAgentIds = await AgentModel.findAccessibleIdsForUser(
      userId,
      isAgentAdmin,
    );

    logger.debug(
      { userId, agentCount: accessibleAgentIds.length },
      "AgentTeamModel.getUserAccessibleAgentIds: completed",
    );
    return accessibleAgentIds;
  }

  /**
   * Check if a user has access to a specific agent: a grant decides for an
   * agent or MCP gateway; see the end of the method for an LLM proxy.
   */
  static async userHasAgentAccess(params: {
    userId: string;
    agentId: string;
    isAgentAdmin: boolean;
    agentAccessContext?: AgentAccessContext | null;
    action?: "read" | "use";
  }): Promise<boolean> {
    const {
      userId,
      agentId,
      isAgentAdmin,
      agentAccessContext,
      action = "read",
    } = params;
    logger.debug(
      { userId, agentId, isAgentAdmin },
      "AgentTeamModel.userHasAgentAccess: checking access",
    );
    const agent =
      agentAccessContext ?? (await findAgentAccessContextById(agentId));

    if (!agent) {
      return false;
    }

    const table = schema.agentsTable;
    const [granted] = await db
      .select({ id: table.id })
      .from(table)
      .where(
        and(
          eq(table.id, agentId),
          or(
            and(
              inArray(table.agentType, ["agent", "profile"]),
              ResourcePermissionPolicyModel.grantCondition({
                organizationId: table.organizationId,
                userId,
                resource: "agent",
                scopeColumn: table.id,
                action,
              }),
            ),
            and(
              eq(table.agentType, "mcp_gateway"),
              ResourcePermissionPolicyModel.grantCondition({
                organizationId: table.organizationId,
                userId,
                resource: "mcpGateway",
                scopeColumn: table.id,
                action,
              }),
            ),
          ),
        ),
      )
      .limit(1);
    if (granted) return true;
    // Agents and MCP gateways are reached through grants alone. An LLM proxy
    // has no grant namespace of its own: the organization's proxy serves every
    // member, and an administrator reaches any proxy row.
    if ((await AgentModel.getAgentType(agentId)) !== "llm_proxy") return false;
    if (isAgentAdmin) return true;
    return AgentModel.isOrganizationLlmProxyFor({ agentId, userId });
  }

  /**
   * The teams an agent's own policy grants read to. Tool policy team
   * conditions, team limits and team statistics read this, so an agent shared
   * with a team by grant counts as that team's agent.
   */
  static async getTeamsForAgent(agentId: string): Promise<string[]> {
    return (
      (await AgentTeamModel.getTeamsForAgents([agentId])).get(agentId) ?? []
    );
  }

  /**
   * Get team details with labels for a specific agent, shaped for trace span
   * attributes. Combines team id/name with each team's labels.
   */
  static async getTeamLabelInfoForAgent(agentId: string): Promise<
    Array<{
      id: string;
      name: string;
      labels: LabelWithDetails[];
    }>
  > {
    const teams = await AgentTeamModel.getTeamDetailsForAgent(agentId);
    if (teams.length === 0) {
      return [];
    }

    const labelsByTeam = await TeamLabelModel.getLabelsForTeams(
      teams.map((team) => team.id),
    );

    return teams.map((team) => ({
      id: team.id,
      name: team.name,
      labels: labelsByTeam.get(team.id) ?? [],
    }));
  }

  /** Team details (id and name) for {@link getTeamsForAgent}. */
  static async getTeamDetailsForAgent(
    agentId: string,
  ): Promise<Array<{ id: string; name: string }>> {
    return (
      (await AgentTeamModel.getTeamDetailsForAgents([agentId])).get(agentId) ??
      []
    );
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
    await withDbTransaction(async (tx) => {
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

  /** {@link getTeamsForAgent} for several agents at once. */
  static async getTeamsForAgents(
    agentIds: string[],
  ): Promise<Map<string, string[]>> {
    const recipients = await ResourcePermissionPolicyModel.findReadRecipients({
      resources: AGENT_RESOURCES,
      scopes: agentIds,
    });
    return new Map(
      agentIds.map((agentId) => [
        agentId,
        recipients.get(agentId)?.teamIds ?? [],
      ]),
    );
  }

  /** Team details (id and name) for {@link getTeamsForAgents}. */
  static async getTeamDetailsForAgents(
    agentIds: string[],
  ): Promise<Map<string, Array<{ id: string; name: string }>>> {
    const teamsByAgent = await AgentTeamModel.getTeamsForAgents(agentIds);
    const teamIds = [...new Set([...teamsByAgent.values()].flat())];
    const teams =
      teamIds.length === 0
        ? []
        : await db
            .select({ id: schema.teamsTable.id, name: schema.teamsTable.name })
            .from(schema.teamsTable)
            .where(inArray(schema.teamsTable.id, teamIds));
    const nameById = new Map(teams.map((team) => [team.id, team.name]));
    return new Map(
      agentIds.map((agentId) => [
        agentId,
        (teamsByAgent.get(agentId) ?? []).flatMap((id) => {
          const name = nameById.get(id);
          return name === undefined ? [] : [{ id, name }];
        }),
      ]),
    );
  }

  /** Agents and MCP gateways whose own policy grants read to `teamId`. */
  static async getAgentIdsForTeam(params: {
    organizationId: string;
    teamId: string;
  }): Promise<string[]> {
    return ResourcePermissionPolicyModel.findScopesReadByTeam({
      ...params,
      resources: AGENT_RESOURCES,
    });
  }

  /**
   * Whether the `agents` row's own policy grants read to the team in
   * `teamColumn`: the join condition for per-team views such as statistics.
   */
  static grantsReadToTeamColumn(teamColumn: SQLWrapper): SQL {
    const table = schema.agentsTable;
    return ResourcePermissionPolicyModel.grantsReadToTeamColumn({
      organizationId: table.organizationId,
      resource: sql`CASE WHEN ${table.agentType} = 'mcp_gateway' THEN 'mcpGateway' ELSE 'agent' END`,
      scopeColumn: table.id,
      teamColumn,
    });
  }
}

export default AgentTeamModel;

// An LLM proxy has no grant namespace, so it reaches no team.
const AGENT_RESOURCES: ScopedResource[] = ["agent", "mcpGateway"];
