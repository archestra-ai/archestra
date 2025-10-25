import { DEFAULT_AGENT_NAME } from "@shared";
import { eq, inArray } from "drizzle-orm";
import db, { schema } from "@/database";
import type { Agent, InsertAgent, UpdateAgent } from "@/types";
import AgentTeamModel from "./agent-team";

class AgentModel {
  static async create({ teams, ...agent }: InsertAgent): Promise<Agent> {
    const [createdAgent] = await db
      .insert(schema.agentsTable)
      .values(agent)
      .returning();

    // Assign teams to the agent if provided
    if (teams && teams.length > 0) {
      await AgentTeamModel.assignTeamsToAgent(createdAgent.id, teams);
    }

    return {
      ...createdAgent,
      tools: [],
      teams: teams || [],
    };
  }

  static async findAll(userId?: string, isAdmin?: boolean): Promise<Agent[]> {
    let query = db
      .select()
      .from(schema.agentsTable)
      .leftJoin(
        schema.agentToolsTable,
        eq(schema.agentsTable.id, schema.agentToolsTable.agentId),
      )
      .leftJoin(
        schema.toolsTable,
        eq(schema.agentToolsTable.toolId, schema.toolsTable.id),
      )
      .$dynamic();

    // Apply access control filtering for non-admins
    if (userId && !isAdmin) {
      const accessibleAgentIds = await AgentTeamModel.getUserAccessibleAgentIds(
        userId,
        false,
      );

      if (accessibleAgentIds.length === 0) {
        return [];
      }

      query = query.where(inArray(schema.agentsTable.id, accessibleAgentIds));
    }

    const rows = await query;

    // Group the flat join results by agent
    const agentsMap = new Map<string, Agent>();

    for (const row of rows) {
      const agent = row.agents;
      const tool = row.tools;

      if (!agentsMap.has(agent.id)) {
        agentsMap.set(agent.id, {
          ...agent,
          tools: [],
          teams: [],
        });
      }

      // Add tool if it exists (leftJoin returns null for agents with no tools)
      if (tool) {
        agentsMap.get(agent.id)?.tools.push(tool);
      }
    }

    const agents = Array.from(agentsMap.values());

    // Populate teams for each agent
    for (const agent of agents) {
      agent.teams = await AgentTeamModel.getTeamsForAgent(agent.id);
    }

    return agents;
  }

  static async findById(
    id: string,
    userId?: string,
    isAdmin?: boolean,
  ): Promise<Agent | null> {
    // Check access control for non-admins
    if (userId && !isAdmin) {
      const hasAccess = await AgentTeamModel.userHasAgentAccess(
        userId,
        id,
        false,
      );
      if (!hasAccess) {
        return null;
      }
    }

    const rows = await db
      .select()
      .from(schema.agentsTable)
      .leftJoin(
        schema.toolsTable,
        eq(schema.agentsTable.id, schema.toolsTable.agentId),
      )
      .where(eq(schema.agentsTable.id, id));

    if (rows.length === 0) {
      return null;
    }

    const agent = rows[0].agents;
    const tools = rows.map((row) => row.tools).filter((tool) => tool !== null);

    const teams = await AgentTeamModel.getTeamsForAgent(id);

    return {
      ...agent,
      tools,
      teams,
    };
  }

  static async getAgentOrCreateDefault(
    name: string | undefined,
  ): Promise<Agent> {
    // First, try to find an agent with isDefault=true
    const rows = await db
      .select()
      .from(schema.agentsTable)
      .leftJoin(
        schema.toolsTable,
        eq(schema.agentsTable.id, schema.toolsTable.agentId),
      )
      .where(eq(schema.agentsTable.isDefault, true));

    if (rows.length > 0) {
      // Default agent exists, return it
      const agent = rows[0].agents;
      const tools = rows
        .map((row) => row.tools)
        .filter((tool) => tool !== null);

      return {
        ...agent,
        tools,
        teams: await AgentTeamModel.getTeamsForAgent(agent.id),
      };
    }

    // No default agent exists, create one
    return AgentModel.create({
      name: name || DEFAULT_AGENT_NAME,
      isDefault: true,
      teams: [],
    });
  }

  static async update(
    id: string,
    { teams, ...agent }: Partial<UpdateAgent>,
  ): Promise<Agent | null> {
    let updatedAgent: Omit<Agent, "tools" | "teams"> | undefined;

    // If setting isDefault to true, unset all other agents' isDefault first
    if (agent.isDefault === true) {
      await db
        .update(schema.agentsTable)
        .set({ isDefault: false })
        .where(eq(schema.agentsTable.isDefault, true));
    }

    // Only update agent table if there are fields to update
    if (Object.keys(agent).length > 0) {
      [updatedAgent] = await db
        .update(schema.agentsTable)
        .set(agent)
        .where(eq(schema.agentsTable.id, id))
        .returning();

      if (!updatedAgent) {
        return null;
      }
    } else {
      // If only updating teams, fetch the existing agent
      const [existingAgent] = await db
        .select()
        .from(schema.agentsTable)
        .where(eq(schema.agentsTable.id, id));

      if (!existingAgent) {
        return null;
      }

      updatedAgent = existingAgent;
    }

    // Sync team assignments if teams is provided
    if (teams !== undefined) {
      await AgentTeamModel.syncAgentTeams(id, teams);
    }

    // Fetch the tools for the updated agent
    const tools = await db
      .select()
      .from(schema.toolsTable)
      .where(eq(schema.toolsTable.agentId, updatedAgent.id));

    // Fetch current teams
    const currentTeams = await AgentTeamModel.getTeamsForAgent(id);

    return {
      ...updatedAgent,
      tools,
      teams: currentTeams,
    };
  }

  static async delete(id: string): Promise<boolean> {
    const result = await db
      .delete(schema.agentsTable)
      .where(eq(schema.agentsTable.id, id));
    return result.rowCount !== null && result.rowCount > 0;
  }
}

export default AgentModel;
