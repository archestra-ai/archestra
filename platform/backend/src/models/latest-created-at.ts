import { type ColumnBaseConfig, eq, sql } from "drizzle-orm";
import type { PgColumn, PgTable } from "drizzle-orm/pg-core";
import db from "@/database";

/**
 * The newest `createdAt` per key, for a bounded list of uuid keys. Keys with
 * no rows are absent from the map.
 *
 * Each key is resolved by its own `ORDER BY created_at DESC NULLS LAST LIMIT 1`
 * probe of a `(key, created_at DESC NULLS LAST)` index; the null ordering must
 * match the index or Postgres sorts the key's rows instead. A
 * `max(created_at) ... GROUP BY key` over the same
 * keys reads every row of every key instead: Postgres only rewrites min/max
 * into an index probe when there is no GROUP BY.
 */
export async function latestCreatedAtByKey(params: {
  table: PgTable;
  keyColumn: PgColumn;
  createdAtColumn: PgColumn<
    ColumnBaseConfig<"date", "PgTimestamp"> & { data: Date; notNull: true }
  >;
  keys: string[];
}): Promise<Map<string, Date>> {
  const { table, keyColumn, createdAtColumn, keys } = params;
  if (keys.length === 0) return new Map();

  const requested = sql`unnest(ARRAY[${sql.join(
    keys.map((key) => sql`${key}`),
    sql`, `,
  )}]::uuid[]) AS requested(key)`;
  const latest = db
    .select({ createdAt: createdAtColumn })
    .from(table)
    .where(eq(keyColumn, sql`requested.key`))
    .orderBy(sql`${createdAtColumn} DESC NULLS LAST`)
    .limit(1)
    .as("latest");

  const rows = await db
    .select({ key: sql<string>`requested.key`, createdAt: latest.createdAt })
    .from(requested)
    .innerJoinLateral(latest, sql`true`);

  return new Map(rows.map((row) => [row.key, row.createdAt]));
}
