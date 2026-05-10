import { and, eq, inArray } from "drizzle-orm";
import db, { schema, type Transaction } from "@/database";
import { notDeleted } from "@/database/schemas/_soft-delete";
import { hardDelete, softDelete } from "@/database/soft-delete";
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
      .where(
        and(eq(schema.secretsTable.id, id), notDeleted(schema.secretsTable)),
      );

    return decryptSecretRow(secret ?? null);
  }

  /**
   * Find a secret by name
   */
  static async findByName(name: string): Promise<SelectSecret | null> {
    const [secret] = await db
      .select()
      .from(schema.secretsTable)
      .where(
        and(
          eq(schema.secretsTable.name, name),
          notDeleted(schema.secretsTable),
        ),
      );

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
      .where(
        and(
          inArray(schema.secretsTable.id, ids),
          notDeleted(schema.secretsTable),
        ),
      );
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
      .where(
        and(eq(schema.secretsTable.id, id), notDeleted(schema.secretsTable)),
      )
      .returning();

    return decryptSecretRow(updatedSecret);
  }

  /**
   * Soft-delete a secret by ID
   */
  static async delete(id: string, tx?: Transaction): Promise<boolean> {
    const count = await softDelete(
      tx ?? db,
      schema.secretsTable,
      eq(schema.secretsTable.id, id),
    );
    return count > 0;
  }

  /**
   * Hard-delete a secret. Reserved for purge flows.
   */
  static async hardDelete(id: string, tx?: Transaction): Promise<boolean> {
    const count = await hardDelete(
      tx ?? db,
      schema.secretsTable,
      eq(schema.secretsTable.id, id),
    );
    return count > 0;
  }
}

export default SecretModel;
