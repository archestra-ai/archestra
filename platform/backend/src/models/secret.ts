import { eq } from "drizzle-orm";
import db, { schema } from "@/database";

export interface Secret {
  id: string;
  secrets: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateSecretInput {
  secrets: Record<string, unknown>;
}

export interface UpdateSecretInput {
  secrets: Record<string, unknown>;
}

class SecretModel {
  /**
   * Create a new secret entry
   */
  static async create(input: CreateSecretInput): Promise<Secret> {
    const [secret] = await db
      .insert(schema.secretsTable)
      .values({
        secrets: input.secrets,
      })
      .returning();

    return secret as Secret;
  }

  /**
   * Find a secret by ID
   */
  static async findById(id: string): Promise<Secret | null> {
    const [secret] = await db
      .select()
      .from(schema.secretsTable)
      .where(eq(schema.secretsTable.id, id));

    return secret ? (secret as Secret) : null;
  }

  /**
   * Update a secret by ID
   */
  static async update(
    id: string,
    input: UpdateSecretInput,
  ): Promise<Secret | null> {
    const [updatedSecret] = await db
      .update(schema.secretsTable)
      .set({
        secrets: input.secrets,
      })
      .where(eq(schema.secretsTable.id, id))
      .returning();

    return updatedSecret ? (updatedSecret as Secret) : null;
  }

  /**
   * Delete a secret by ID
   */
  static async delete(id: string): Promise<boolean> {
    const result = await db
      .delete(schema.secretsTable)
      .where(eq(schema.secretsTable.id, id));

    return result.rowCount !== null && result.rowCount > 0;
  }
}

export default SecretModel;
