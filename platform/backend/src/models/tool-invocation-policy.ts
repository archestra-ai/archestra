import { eq } from "drizzle-orm";
import db, { schema } from "../database";
import type {
  InsertToolInvocationPolicy,
  ToolInvocationPolicy,
} from "../types";

class ToolInvocationPolicyModel {
  static async create(
    policy: InsertToolInvocationPolicy,
  ): Promise<ToolInvocationPolicy> {
    const [createdPolicy] = await db
      .insert(schema.toolInvocationPoliciesTable)
      .values(policy)
      .returning();
    return createdPolicy;
  }

  static async findAll(): Promise<ToolInvocationPolicy[]> {
    return db.select().from(schema.toolInvocationPoliciesTable);
  }

  static async findById(id: string): Promise<ToolInvocationPolicy | null> {
    const [policy] = await db
      .select()
      .from(schema.toolInvocationPoliciesTable)
      .where(eq(schema.toolInvocationPoliciesTable.id, id));
    return policy || null;
  }

  static async findByToolId(toolId: string): Promise<ToolInvocationPolicy[]> {
    return db
      .select()
      .from(schema.toolInvocationPoliciesTable)
      .where(eq(schema.toolInvocationPoliciesTable.toolId, toolId));
  }

  static async update(
    id: string,
    policy: Partial<InsertToolInvocationPolicy>,
  ): Promise<ToolInvocationPolicy | null> {
    const [updatedPolicy] = await db
      .update(schema.toolInvocationPoliciesTable)
      .set(policy)
      .where(eq(schema.toolInvocationPoliciesTable.id, id))
      .returning();
    return updatedPolicy || null;
  }

  static async delete(id: string): Promise<boolean> {
    const result = await db
      .delete(schema.toolInvocationPoliciesTable)
      .where(eq(schema.toolInvocationPoliciesTable.id, id));
    return result.rowCount !== null && result.rowCount > 0;
  }
}

export default ToolInvocationPolicyModel;
