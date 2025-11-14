import { and, desc, eq } from "drizzle-orm";
import db, { schema } from "@/database";
import type { InsertToolPolicy, ToolPolicy, UpdateToolPolicy } from "@/types";

class ToolPolicyModel {
  /**
   * Create a new tool policy
   */
  static async create(toolPolicy: InsertToolPolicy): Promise<ToolPolicy> {
    const [createdToolPolicy] = await db
      .insert(schema.toolPoliciesTable)
      .values(toolPolicy)
      .returning();
    return createdToolPolicy;
  }

  /**
   * Find a tool policy by ID
   */
  static async findById(id: string): Promise<ToolPolicy | null> {
    const [toolPolicy] = await db
      .select()
      .from(schema.toolPoliciesTable)
      .where(eq(schema.toolPoliciesTable.id, id));

    return toolPolicy || null;
  }

  /**
   * Find all tool policies for a specific tool
   */
  static async findAllByToolId(toolId: string): Promise<ToolPolicy[]> {
    return db
      .select()
      .from(schema.toolPoliciesTable)
      .where(eq(schema.toolPoliciesTable.toolId, toolId))
      .orderBy(desc(schema.toolPoliciesTable.createdAt));
  }

  /**
   * Find all tool policies for an organization
   */
  static async findAllByOrganization(
    organizationId: string,
  ): Promise<ToolPolicy[]> {
    return db
      .select()
      .from(schema.toolPoliciesTable)
      .where(eq(schema.toolPoliciesTable.organizationId, organizationId))
      .orderBy(desc(schema.toolPoliciesTable.createdAt));
  }

  /**
   * Find all tool policies (optionally filtered by tool ID or organization)
   */
  static async findAll(filters?: {
    toolId?: string;
    organizationId?: string;
  }): Promise<ToolPolicy[]> {
    let query = db
      .select()
      .from(schema.toolPoliciesTable)
      .orderBy(desc(schema.toolPoliciesTable.createdAt))
      .$dynamic();

    if (filters?.toolId && filters?.organizationId) {
      query = query.where(
        and(
          eq(schema.toolPoliciesTable.toolId, filters.toolId),
          eq(schema.toolPoliciesTable.organizationId, filters.organizationId),
        ),
      );
    } else if (filters?.toolId) {
      query = query.where(eq(schema.toolPoliciesTable.toolId, filters.toolId));
    } else if (filters?.organizationId) {
      query = query.where(
        eq(schema.toolPoliciesTable.organizationId, filters.organizationId),
      );
    }

    return query;
  }

  /**
   * Update a tool policy
   */
  static async update(
    id: string,
    data: UpdateToolPolicy,
  ): Promise<ToolPolicy | null> {
    const [updatedToolPolicy] = await db
      .update(schema.toolPoliciesTable)
      .set({
        ...data,
        updatedAt: new Date(),
      })
      .where(eq(schema.toolPoliciesTable.id, id))
      .returning();

    return updatedToolPolicy || null;
  }

  /**
   * Delete a tool policy
   */
  static async delete(id: string): Promise<boolean> {
    const result = await db
      .delete(schema.toolPoliciesTable)
      .where(eq(schema.toolPoliciesTable.id, id));

    return result.rowCount !== null && result.rowCount > 0;
  }

  /**
   * Get the effective tool policy for an agent-tool combination
   * Returns the policy if one is assigned, otherwise null (meaning default rules apply)
   */
  static async findByAgentTool(
    agentId: string,
    toolId: string,
  ): Promise<ToolPolicy | null> {
    const [agentTool] = await db
      .select({
        toolPolicy: schema.toolPoliciesTable,
      })
      .from(schema.agentToolsTable)
      .innerJoin(
        schema.toolPoliciesTable,
        eq(schema.agentToolsTable.toolPolicyId, schema.toolPoliciesTable.id),
      )
      .where(
        and(
          eq(schema.agentToolsTable.agentId, agentId),
          eq(schema.agentToolsTable.toolId, toolId),
        ),
      );

    return agentTool?.toolPolicy || null;
  }

  /**
   * Find tool policy by name
   */
  static async findByName(name: string): Promise<ToolPolicy | null> {
    const [toolPolicy] = await db
      .select()
      .from(schema.toolPoliciesTable)
      .where(eq(schema.toolPoliciesTable.name, name));

    return toolPolicy || null;
  }

  /**
   * Get agent assignments for a specific tool policy
   * Returns list of agents that are using this policy
   */
  static async getAgentAssignments(
    policyId: string,
  ): Promise<Array<{ agentId: string; agentName: string }>> {
    const assignments = await db
      .select({
        agentId: schema.agentToolsTable.agentId,
        agentName: schema.agentsTable.name,
      })
      .from(schema.agentToolsTable)
      .innerJoin(
        schema.agentsTable,
        eq(schema.agentToolsTable.agentId, schema.agentsTable.id),
      )
      .where(eq(schema.agentToolsTable.toolPolicyId, policyId));

    return assignments;
  }
}

export default ToolPolicyModel;
