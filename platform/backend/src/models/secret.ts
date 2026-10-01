import { count, eq, inArray, is, or, sql } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import db, { schema, withDbTransaction } from "@/database";
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
  static async isReferencedByMcpCatalog(id: string): Promise<boolean> {
    const [row] = await db
      .select({ id: schema.internalMcpCatalogTable.id })
      .from(schema.internalMcpCatalogTable)
      .where(
        or(
          eq(schema.internalMcpCatalogTable.localConfigSecretId, id),
          eq(schema.internalMcpCatalogTable.clientSecretId, id),
        ),
      )
      .limit(1);
    return row !== undefined;
  }

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
   * All secret rows exactly as stored, without decryption. Used by the
   * startup encryption-key canary check, which probes decryptability itself.
   */
  static async findAllRaw(): Promise<SelectSecret[]> {
    return db.select().from(schema.secretsTable);
  }

  static async count(): Promise<number> {
    const [{ secretCount }] = await db
      .select({ secretCount: count() })
      .from(schema.secretsTable);
    return secretCount;
  }

  /**
   * Overwrite a row's stored secret blob directly, WITHOUT re-encrypting.
   * Used only by the encryption-key re-encryption migration, which supplies a
   * value already encrypted under the new key. Never use for normal writes —
   * those go through {@link create}/{@link update}, which encrypt.
   */
  static async updateRawSecret(
    id: string,
    encrypted: { __encrypted: string },
  ): Promise<void> {
    await db
      .update(schema.secretsTable)
      .set({ secret: encrypted })
      .where(eq(schema.secretsTable.id, id));
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

  /** Reclaim a retired bag without clearing a concurrently attached FK. */
  static async deleteIfUnreferenced(params: {
    id: string;
    deleteExternal?: (
      secret: Pick<SelectSecret, "id" | "name" | "isVault">,
    ) => Promise<void>;
  }): Promise<boolean> {
    return withDbTransaction(async (tx) => {
      const [secret] = await tx
        .select()
        .from(schema.secretsTable)
        .where(eq(schema.secretsTable.id, params.id))
        .for("update");
      if (!secret) return false;

      // Derive owners from the schema so legacy presets, soft-deleted rows,
      // installations and other credential consumers all retain their bags.
      // FOR UPDATE also blocks new FK references until the decision commits.
      const ownerQueries = Object.values(schema).flatMap((table) => {
        if (!is(table, PgTable)) return [];
        return getTableConfig(table).foreignKeys.flatMap((key) => {
          const reference = key.reference();
          if (reference.foreignTable !== schema.secretsTable) return [];
          return reference.columns.map(
            (column) =>
              sql`select 1 from ${table} where ${column} = ${params.id}`,
          );
        });
      });
      // The creator's cleanup can arrive after another edit has already
      // replaced its published bag. Its durable retirement still grants the
      // snapshot grace period even though no catalog points at it now.
      ownerQueries.push(sql`select 1 from ${schema.tasksTable}
        where ${schema.tasksTable.taskType} = 'mcp_catalog_secret_retirement'
          and ${schema.tasksTable.scheduledFor} > now()
          and ${schema.tasksTable.payload}->'secretIds' @> ${JSON.stringify([params.id])}::jsonb`);
      const { rows } = await tx.execute<{ referenced: boolean }>(
        sql`select exists(${sql.join(ownerQueries, sql` union all `)}) as referenced`,
      );
      if (rows[0].referenced) return false;
      await params.deleteExternal?.(secret);
      await tx
        .delete(schema.secretsTable)
        .where(eq(schema.secretsTable.id, params.id));
      return true;
    });
  }
}

export default SecretModel;
