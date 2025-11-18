import {
  index,
  integer,
  pgTable,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import limitsTable from "./limit";

/**
 * Tracks per-model token usage for token_cost limits.
 * Works with limits.model (JSONB array) which defines which models a limit covers.
 * This table tracks actual runtime usage for each (limit, model) pair to enable precise cost calculation.
 */
const limitModelUsageTable = pgTable(
  "limit_model_usage",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    limitId: uuid("limit_id")
      .notNull()
      .references(() => limitsTable.id, { onDelete: "cascade" }),
    model: varchar("model", { length: 255 }).notNull(),
    currentUsageTokensIn: integer("current_usage_tokens_in")
      .notNull()
      .default(0),
    currentUsageTokensOut: integer("current_usage_tokens_out")
      .notNull()
      .default(0),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "date" })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => ({
    limitIdIdx: index("limit_model_usage_limit_id_idx").on(table.limitId),
    limitModelIdx: index("limit_model_usage_limit_model_idx").on(
      table.limitId,
      table.model,
    ),
  }),
);

export default limitModelUsageTable;
