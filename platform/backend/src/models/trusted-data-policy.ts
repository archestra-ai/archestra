import { eq } from "drizzle-orm";
import db, { schema } from "../database";
import type { InsertTrustedDataPolicy, TrustedDataPolicy } from "../types";

class TrustedDataPolicyModel {
  static async create(
    policy: InsertTrustedDataPolicy,
  ): Promise<TrustedDataPolicy> {
    const [createdPolicy] = await db
      .insert(schema.trustedDataPoliciesTable)
      .values(policy)
      .returning();
    return createdPolicy;
  }

  static async findAll(): Promise<TrustedDataPolicy[]> {
    return db.select().from(schema.trustedDataPoliciesTable);
  }

  static async findById(id: string): Promise<TrustedDataPolicy | null> {
    const [policy] = await db
      .select()
      .from(schema.trustedDataPoliciesTable)
      .where(eq(schema.trustedDataPoliciesTable.id, id));
    return policy || null;
  }

  static async findByToolId(toolId: string): Promise<TrustedDataPolicy[]> {
    return db
      .select()
      .from(schema.trustedDataPoliciesTable)
      .where(eq(schema.trustedDataPoliciesTable.toolId, toolId));
  }

  static async update(
    id: string,
    policy: Partial<InsertTrustedDataPolicy>,
  ): Promise<TrustedDataPolicy | null> {
    const [updatedPolicy] = await db
      .update(schema.trustedDataPoliciesTable)
      .set(policy)
      .where(eq(schema.trustedDataPoliciesTable.id, id))
      .returning();
    return updatedPolicy || null;
  }

  static async delete(id: string): Promise<boolean> {
    const result = await db
      .delete(schema.trustedDataPoliciesTable)
      .where(eq(schema.trustedDataPoliciesTable.id, id));
    return result.rowCount !== null && result.rowCount > 0;
  }
}

export default TrustedDataPolicyModel;
