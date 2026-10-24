import {
  getTableColumns,
  type InferSelectModel,
  type SQL,
  sql,
} from "drizzle-orm";
import type { AnyPgTable } from "drizzle-orm/pg-core";
import { qualified } from "./utils/qualified-column";

/** Preserve Drizzle's column decoders when batching rows into a JSON result. */
export class JsonRowCodec<T extends AnyPgTable> {
  private readonly columns;
  readonly selection: SQL;

  constructor(table: T) {
    this.columns = Object.entries(getTableColumns(table));
    this.selection = sql.join(
      this.columns.map(([key, column]) => {
        // Dates must keep the database's timezone semantics. Numeric and bigint
        // text avoids JSON's numeric precision limit; JSON/array text goes through
        // the same column decoder as a normal Drizzle result.
        const text =
          ["date", "json", "array", "bigint"].includes(column.dataType) ||
          column.getSQLType().startsWith("numeric");
        const value = text
          ? sql`${qualified(column)}::text`
          : qualified(column);
        return sql`${value} AS ${sql.identifier(key)}`;
      }),
      sql`, `,
    );
  }

  decode(raw: Record<string, unknown>): InferSelectModel<T> {
    const decoded: Record<string, unknown> = {};
    for (const [key, column] of this.columns) {
      if (!Object.hasOwn(raw, key))
        throw new Error(`Missing database field: ${key}`);
      const value = raw[key];
      decoded[key] = value === null ? null : column.mapFromDriverValue(value);
    }
    return decoded as InferSelectModel<T>;
  }
}
