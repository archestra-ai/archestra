import { type SQL, sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";

/** Keep bulk reads below PostgreSQL's bind-parameter limit, including empty sets. */
export function idArrayCondition(
  column: AnyPgColumn,
  ids: readonly string[],
): SQL {
  return sql`${column} = ANY(${sql.param(ids)}::${sql.raw(column.getSQLType())}[])`;
}
