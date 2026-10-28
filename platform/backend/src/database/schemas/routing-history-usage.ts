import { bigint, index, pgTable, timestamp, uuid } from "drizzle-orm/pg-core";
import routingHistorySessionsTable from "./routing-history-session";

/** Usage of one past interaction of a sampled history session; `created_at` is the interaction's. */
const routingHistoryUsageTable = pgTable(
  "routing_history_usage",
  {
    interactionId: uuid("interaction_id").primaryKey(),
    historySessionId: uuid("history_session_id")
      .notNull()
      .references(() => routingHistorySessionsTable.id, {
        onDelete: "cascade",
      }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    input: bigint("input", { mode: "number" }).notNull(),
    cacheRead: bigint("cache_read", { mode: "number" }).notNull(),
    cacheWrite: bigint("cache_write", { mode: "number" }).notNull(),
    cacheWrite1h: bigint("cache_write_1h", { mode: "number" }).notNull(),
    output: bigint("output", { mode: "number" }).notNull(),
  },
  (table) => [
    index("routing_history_usage_session_idx").on(table.historySessionId),
  ],
);

export default routingHistoryUsageTable;
