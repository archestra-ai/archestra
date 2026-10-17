import { getTableName, type SQL, sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";

/**
 * A column with its table's name, for a subselect correlated to the outer
 * row. Drizzle renders a single-table select's columns bare, and a subselect
 * resolves a bare name against its own tables: `"agent_id" = "id"` would
 * compare two columns of the inner table.
 */
export function qualified(column: AnyPgColumn): SQL {
  return sql`${sql.identifier(getTableName(column.table))}.${sql.identifier(column.name)}`;
}
