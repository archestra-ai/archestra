import { eq } from "drizzle-orm";
import db, { schema } from "../database";
import type { Agent, InsertAgent } from "../types";

class AgentModel {
  static async create(agent: InsertAgent): Promise<Agent> {
    const [createdAgent] = await db
      .insert(schema.agentsTable)
      .values(agent)
      .returning();
    return createdAgent;
  }

  static async findAll(): Promise<Agent[]> {
    return db.select().from(schema.agentsTable);
  }

  static async findById(id: string): Promise<Agent | null> {
    const [agent] = await db
      .select()
      .from(schema.agentsTable)
      .where(eq(schema.agentsTable.id, id));
    return agent || null;
  }

  static async ensureDefaultAgentExists(
    name: string | undefined,
  ): Promise<Agent> {
    const agentName = name || "Default Agent";

    const [agent] = await db
      .select()
      .from(schema.agentsTable)
      .where(eq(schema.agentsTable.name, agentName));

    if (!agent) {
      return await AgentModel.create({ name: agentName });
    }
    return agent;
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
    return updatedAgent || null;
  }

  static async delete(id: string): Promise<boolean> {
    const result = await db
      .delete(schema.agentsTable)
      .where(eq(schema.agentsTable.id, id));
    return result.rowCount !== null && result.rowCount > 0;
  }
}

export default AgentModel;
