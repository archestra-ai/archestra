import { eq } from "drizzle-orm";
import db, { schema } from "@/database";

export interface Secret {
  id: string;
  secret: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateSecretInput {
  secret: Record<string, unknown>;
}

export interface UpdateSecretInput {
  secret: Record<string, unknown>;
}

class SecretModel {
  /**
   * Create a new secret entry
   */
  static async create(input: CreateSecretInput): Promise<Secret> {
    const [secret] = await db
      .insert(schema.secretsTable)
      .values({
        secret: input.secret,
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
        secret: input.secret,
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

  /**
   * Create a secret for MCP server environment variables
   */
  static async createMcpServerSecret(
    envVars: Record<string, string>,
  ): Promise<Secret> {
    return await SecretModel.create({ secret: envVars });
  }

  /**
   * Get MCP server environment variable secrets
   */
  static async getMcpServerSecret(secretId: string): Promise<Secret | null> {
    return await SecretModel.findById(secretId);
  }

  /**
   * Delete MCP server environment variable secrets
   */
  static async deleteMcpServerSecret(secretId: string): Promise<boolean> {
    return await SecretModel.delete(secretId);
  }
}

export default SecretModel;
