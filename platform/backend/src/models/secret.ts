import { eq, inArray } from "drizzle-orm";
import db, { schema } from "@/database";
import type { InsertSecret, SelectSecret, UpdateSecret } from "@/types";
import {
  decryptSecretValue,
  encryptSecretValue,
  isEncryptedSecret,
} from "@/utils/crypto";

function decryptSecretRow<T extends SelectSecret | null | undefined>(
  row: T,
): T {
  if (!row) return row;
  if (isEncryptedSecret(row.secret)) {
    return { ...row, secret: decryptSecretValue(row.secret) };
  }
  return row;
}

class SecretModel {
  /**
   * Create a new secret entry
   */
  static async create(input: InsertSecret): Promise<SelectSecret> {
    const [secret] = await db
      .insert(schema.secretsTable)
      .values({ ...input, secret: encryptSecretValue(input.secret) })
      .returning();

    return decryptSecretRow(secret);
  }

  /**
   * Find a secret by ID
   */
  static async findById(id: string): Promise<SelectSecret | null> {
    const [secret] = await db
      .select()
      .from(schema.secretsTable)
      .where(eq(schema.secretsTable.id, id));

    return decryptSecretRow(secret ?? null);
  }

  /**
   * Find a secret by name
   */
  static async findByName(name: string): Promise<SelectSecret | null> {
    const [secret] = await db
      .select()
      .from(schema.secretsTable)
      .where(eq(schema.secretsTable.name, name));

    return decryptSecretRow(secret ?? null);
  }

  /**
   * Find multiple secrets by IDs in a single query
   */
  static async findByIds(ids: string[]): Promise<SelectSecret[]> {
    if (ids.length === 0) return [];
    const rows = await db
      .select()
      .from(schema.secretsTable)
      .where(inArray(schema.secretsTable.id, ids));
    return rows.map((row) => decryptSecretRow(row));
  }

  /**
   * Update a secret by ID
   */
  static async update(
    id: string,
    input: UpdateSecret,
  ): Promise<SelectSecret | null> {
    const values = input.secret
      ? { ...input, secret: encryptSecretValue(input.secret) }
      : input;

    const [updatedSecret] = await db
      .update(schema.secretsTable)
      .set(values)
      .where(eq(schema.secretsTable.id, id))
      .returning();

    return decryptSecretRow(updatedSecret);
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
