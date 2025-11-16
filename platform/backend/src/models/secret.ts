import { eq } from "drizzle-orm";
import db, { schema } from "@/database";
import type {
  InsertSecret,
  SecretValue,
  SelectSecret,
  UpdateSecret,
} from "@/types";

class SecretModel {
  /**
   * Create a new secret entry
   */
  static async create(input: InsertSecret): Promise<SelectSecret> {
    const [secret] = await db
      .insert(schema.secretsTable)
      .values(input)
      .returning();

    return secret;
  }

  /**
   * Find a secret by ID
   */
  static async findById(id: string): Promise<SelectSecret | null> {
    const [secret] = await db
      .select()
      .from(schema.secretsTable)
      .where(eq(schema.secretsTable.id, id));

    return secret;
  }

  /**
   * Update a secret by ID
   */
  static async update(
    id: string,
    input: UpdateSecret,
  ): Promise<UpdateSecret | null> {
    const [updatedSecret] = await db
      .update(schema.secretsTable)
      .set(input)
      .where(eq(schema.secretsTable.id, id))
      .returning();

    return updatedSecret;
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
    envVars: SecretValue,
  ): Promise<SelectSecret> {
    return await SecretModel.create({
      secret: envVars,
    });
  }

  /**
   * Get MCP server environment variable secrets
   */
  static async getMcpServerSecret(
    secretId: string,
  ): Promise<SelectSecret | null> {
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
