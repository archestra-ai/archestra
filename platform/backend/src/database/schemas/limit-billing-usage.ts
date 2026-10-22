import {
  bigint,
  integer,
  numeric,
  pgTable,
  primaryKey,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import limitsTable from "./limit";

/**
 * Replaces the covered portion of legacy token counters with settled USD.
 * Uncovered counters remain readable during mixed-version deployments.
 */
export default pgTable(
  "limit_billing_usage",
  {
    limitId: uuid("limit_id")
      .notNull()
      .references(() => limitsTable.id, { onDelete: "cascade" }),
    model: varchar("model", { length: 255 }).notNull(),
    coveredTokensIn: bigint("covered_tokens_in", { mode: "number" })
      .notNull()
      .default(0),
    coveredTokensOut: bigint("covered_tokens_out", { mode: "number" })
      .notNull()
      .default(0),
    cost: numeric("cost", { precision: 24, scale: 10 }).notNull().default("0"),
    incomplete: integer("incomplete").notNull().default(0),
  },
  (table) => [primaryKey({ columns: [table.limitId, table.model] })],
);
