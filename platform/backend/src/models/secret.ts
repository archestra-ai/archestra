import { eq, like } from "drizzle-orm";
import db, { schema } from "@/database";
import logger from "@/logging";
import type { InsertSecret, SelectSecret, UpdateSecret } from "@/types";

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
   * Create a secret record that references an external Vault path (BYOS feature).
   * The actual secret value is stored in the external Vault, not in the database.
   */
  static async createWithVaultPath(input: {
    name: string;
    vaultPath: string;
  }): Promise<SelectSecret> {
    logger.debug(
      { name: input.name, vaultPath: input.vaultPath },
      "SecretModel.createWithVaultPath: creating external vault secret",
    );

    const [secret] = await db
      .insert(schema.secretsTable)
      .values({
        name: input.name,
        secret: {}, // Empty - actual value is in external Vault
        isVault: true,
        vaultPath: input.vaultPath,
      })
      .returning();

    logger.debug(
      { secretId: secret.id },
      "SecretModel.createWithVaultPath: completed",
    );
    return secret;
  }

  /**
   * Check if a secret uses an external Vault path (BYOS feature)
   */
  static async isExternalVaultSecret(secretId: string): Promise<boolean> {
    const [secret] = await db
      .select({ vaultPath: schema.secretsTable.vaultPath })
      .from(schema.secretsTable)
      .where(eq(schema.secretsTable.id, secretId))
      .limit(1);

    return !!secret?.vaultPath;
  }

  /**
   * Find secrets by Vault path prefix.
   * Useful for finding all secrets that belong to a team's Vault folder.
   */
  static async findByVaultPathPrefix(
    pathPrefix: string,
  ): Promise<SelectSecret[]> {
    logger.debug(
      { pathPrefix },
      "SecretModel.findByVaultPathPrefix: fetching secrets",
    );

    const secrets = await db
      .select()
      .from(schema.secretsTable)
      .where(like(schema.secretsTable.vaultPath, `${pathPrefix}%`));

    logger.debug(
      { pathPrefix, count: secrets.length },
      "SecretModel.findByVaultPathPrefix: completed",
    );
    return secrets;
  }

  /**
   * Find a secret by ID
   */
  static async findById(id: string): Promise<SelectSecret | null> {
    const [secret] = await db
      .select()
      .from(schema.secretsTable)
      .where(eq(schema.secretsTable.id, id));

    return secret ?? null;
  }

  /**
   * Update a secret by ID
   */
  static async update(
    id: string,
    input: UpdateSecret,
  ): Promise<SelectSecret | null> {
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
    // First check if the secret exists
    const existing = await SecretModel.findById(id);
    if (!existing) {
      return false;
    }

    await db.delete(schema.secretsTable).where(eq(schema.secretsTable.id, id));

    return true;
  }
}

export default SecretModel;
