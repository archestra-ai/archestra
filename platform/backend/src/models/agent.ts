import { and, eq } from "drizzle-orm";
import db, { schema } from "../database";
import type { Agent, InsertAgent, ToolInvocation, TrustedData } from "../types";

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

  // Tool Invocation Policy Assignment Methods
  static async assignToolInvocationPolicy(
    agentId: string,
    policyId: string,
  ): Promise<void> {
    await db
      .insert(schema.agentToolInvocationPoliciesTable)
      .values({ agentId, policyId })
      .onConflictDoNothing();
  }

  static async unassignToolInvocationPolicy(
    agentId: string,
    policyId: string,
  ): Promise<boolean> {
    const result = await db
      .delete(schema.agentToolInvocationPoliciesTable)
      .where(
        and(
          eq(schema.agentToolInvocationPoliciesTable.agentId, agentId),
          eq(schema.agentToolInvocationPoliciesTable.policyId, policyId),
        ),
      );
    return result.rowCount !== null && result.rowCount > 0;
  }

  static async getToolInvocationPolicies(
    agentId: string,
  ): Promise<ToolInvocation.ToolInvocationPolicy[]> {
    const results = await db
      .select({
        policy: schema.toolInvocationPoliciesTable,
      })
      .from(schema.agentToolInvocationPoliciesTable)
      .innerJoin(
        schema.toolInvocationPoliciesTable,
        eq(
          schema.agentToolInvocationPoliciesTable.policyId,
          schema.toolInvocationPoliciesTable.id,
        ),
      )
      .where(eq(schema.agentToolInvocationPoliciesTable.agentId, agentId));

    return results.map((r) => r.policy);
  }

  // Trusted Data Policy Assignment Methods
  static async assignTrustedDataPolicy(
    agentId: string,
    policyId: string,
  ): Promise<void> {
    await db
      .insert(schema.agentTrustedDataPoliciesTable)
      .values({ agentId, policyId })
      .onConflictDoNothing();
  }

  static async unassignTrustedDataPolicy(
    agentId: string,
    policyId: string,
  ): Promise<boolean> {
    const result = await db
      .delete(schema.agentTrustedDataPoliciesTable)
      .where(
        and(
          eq(schema.agentTrustedDataPoliciesTable.agentId, agentId),
          eq(schema.agentTrustedDataPoliciesTable.policyId, policyId),
        ),
      );
    return result.rowCount !== null && result.rowCount > 0;
  }

  static async getTrustedDataPolicies(
    agentId: string,
  ): Promise<TrustedData.TrustedDataPolicy[]> {
    const results = await db
      .select({
        policy: schema.trustedDataPoliciesTable,
      })
      .from(schema.agentTrustedDataPoliciesTable)
      .innerJoin(
        schema.trustedDataPoliciesTable,
        eq(
          schema.agentTrustedDataPoliciesTable.policyId,
          schema.trustedDataPoliciesTable.id,
        ),
      )
      .where(eq(schema.agentTrustedDataPoliciesTable.agentId, agentId));

    return results.map((r) => r.policy);
  }
}

export default AgentModel;
