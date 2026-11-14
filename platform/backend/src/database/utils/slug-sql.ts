import { type SQL, sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";

/**
 * `slugifyMcpServerName` in SQL: lowercase, whitespace runs to `_`, anything
 * but `[a-z0-9_-]` removed.
 */
export function slugifyMcpServerNameSql(value: AnyPgColumn | SQL): SQL {
  return sql`regexp_replace(regexp_replace(lower(${value}), '[[:space:]]+', '_', 'g'), '[^a-z0-9_-]', '', 'g')`;
}
