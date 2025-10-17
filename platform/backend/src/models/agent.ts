import { DEFAULT_AGENT_NAME } from "@shared";
import { eq, inArray } from "drizzle-orm";
import db, { schema } from "@/database";
import type { Agent, InsertAgent, UpdateAgent } from "@/types";
import AgentAccessControlModel from "./agent-access-control";

class AgentModel {
  static async create(
    { usersWithAccess, ...agent }: InsertAgent,
    creatorUserId?: string,
  ): Promise<Agent> {
    const [createdAgent] = await db
      .insert(schema.agentsTable)
      .values(agent)
      .returning();

    const userIdsToGrant: string[] = [];

    if (creatorUserId) {
      // Auto-grant creator access
      userIdsToGrant.push(creatorUserId);
    }

    if (usersWithAccess.length > 0) {
      userIdsToGrant.push(...usersWithAccess);
    }

    await AgentAccessControlModel.grantAgentAccess(
      createdAgent.id,
      userIdsToGrant,
    );

    return {
      ...createdAgent,
      tools: [],
      usersWithAccess: userIdsToGrant,
    };
  }

  static async findAll(userId?: string, isAdmin?: boolean): Promise<Agent[]> {
    let query = db
      .select()
      .from(schema.agentsTable)
      .leftJoin(
        schema.toolsTable,
        eq(schema.agentsTable.id, schema.toolsTable.agentId),
      )
      .$dynamic();

    // Apply access control filtering for non-admins
    if (userId && !isAdmin) {
      const accessibleAgentIds =
        await AgentAccessControlModel.getUserAccessibleAgentIds(userId);

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
          usersWithAccess: [],
        });
      }

      // Add tool if it exists (leftJoin returns null for agents with no tools)
      if (tool) {
        agentsMap.get(agent.id)?.tools.push(tool);
      }
    }

    const agents = Array.from(agentsMap.values());

    // Populate usersWithAccess for each agent
    for (const agent of agents) {
      agent.usersWithAccess =
        await AgentAccessControlModel.getUsersWithAccessToAgent(agent.id);
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
      const hasAccess = await AgentAccessControlModel.userHasAgentAccess(
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

    const usersWithAccess =
      await AgentAccessControlModel.getUsersWithAccessToAgent(id);

    return {
      ...agent,
      tools,
      usersWithAccess,
    };
  }

  static async getAgentOrCreateDefault(
    name: string | undefined,
  ): Promise<Agent> {
    const agentName = name || DEFAULT_AGENT_NAME;

    const rows = await db
      .select()
      .from(schema.agentsTable)
      .leftJoin(
        schema.toolsTable,
        eq(schema.agentsTable.id, schema.toolsTable.agentId),
      )
      .where(eq(schema.agentsTable.name, agentName));

    if (rows.length === 0) {
      return AgentModel.create({ name: agentName, usersWithAccess: [] });
    }

    const agent = rows[0].agents;
    const tools = rows.map((row) => row.tools).filter((tool) => tool !== null);

    const usersWithAccess =
      await AgentAccessControlModel.getUsersWithAccessToAgent(agent.id);

    return {
      ...agent,
      tools,
      usersWithAccess,
    };
  }

  static async update(
    id: string,
    { usersWithAccess, ...agent }: Partial<UpdateAgent>,
  ): Promise<Agent | null> {
    let updatedAgent: Omit<Agent, "tools" | "usersWithAccess"> | undefined;

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
      // If only updating usersWithAccess, fetch the existing agent
      const [existingAgent] = await db
        .select()
        .from(schema.agentsTable)
        .where(eq(schema.agentsTable.id, id));

      if (!existingAgent) {
        return null;
      }

      updatedAgent = existingAgent;
    }

    // Sync access control if usersWithAccess is provided
    if (usersWithAccess) {
      await AgentAccessControlModel.syncAgentAccess(id, usersWithAccess);
    }

    // Fetch the tools for the updated agent
    const tools = await db
      .select()
      .from(schema.toolsTable)
      .where(eq(schema.toolsTable.agentId, updatedAgent.id));

    // Fetch current usersWithAccess
    const currentUsersWithAccess =
      await AgentAccessControlModel.getUsersWithAccessToAgent(id);

    return {
      ...updatedAgent,
      tools,
      usersWithAccess: currentUsersWithAccess,
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
