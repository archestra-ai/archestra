import { DEFAULT_AGENT_NAME } from "@shared";
import { eq } from "drizzle-orm";
import db, { schema } from "@/database";
import type { Agent, InsertAgent } from "@/types";

class AgentModel {
  static async create(agent: InsertAgent): Promise<Agent> {
    const [createdAgent] = await db
      .insert(schema.agentsTable)
      .values(agent)
      .returning();

    return {
      ...createdAgent,
      tools: [],
    };
  }

  static async findAll(): Promise<Agent[]> {
    const rows = await db
      .select()
      .from(schema.agentsTable)
      .leftJoin(
        schema.toolsTable,
        eq(schema.agentsTable.id, schema.toolsTable.agentId),
      );

    // Group the flat join results by agent
    const agentsMap = new Map<string, Agent>();

    for (const row of rows) {
      const agent = row.agents;
      const tool = row.tools;

      if (!agentsMap.has(agent.id)) {
        agentsMap.set(agent.id, {
          ...agent,
          tools: [],
        });
      }

      // Add tool if it exists (leftJoin returns null for agents with no tools)
      if (tool) {
        agentsMap.get(agent.id)?.tools.push(tool);
      }
    }

    return Array.from(agentsMap.values());
  }

  static async findById(id: string): Promise<Agent | null> {
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

    return {
      ...agent,
      tools,
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
      return await AgentModel.create({ name: agentName });
    }

    const agent = rows[0].agents;
    const tools = rows.map((row) => row.tools).filter((tool) => tool !== null);

    return {
      ...agent,
      tools,
    };
  }

  static async update(
    id: string,
    agent: Partial<InsertAgent>,
  ): Promise<Agent | null> {
    const [updatedAgent] = await db
      .update(schema.agentsTable)
      .set(agent)
      .where(eq(schema.agentsTable.id, id))
      .returning();

    if (!updatedAgent) {
      return null;
    }

    // Fetch the tools for the updated agent
    const tools = await db
      .select()
      .from(schema.toolsTable)
      .where(eq(schema.toolsTable.agentId, updatedAgent.id));

    return {
      ...updatedAgent,
      tools,
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
