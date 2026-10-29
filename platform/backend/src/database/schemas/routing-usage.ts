import {
  bigint,
  boolean,
  index,
  pgTable,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

/**
 * Usage of one auto-routed interaction, appended in the interaction's write
 * transaction. Neither key is a foreign key: interactions retention must not
 * cascade here, and a purged decision must never fail a completion — its
 * contributions become orphans that the fit's inner join ignores.
 */
const routingUsageTable = pgTable(
  "routing_usage",
  {
    interactionId: uuid("interaction_id").primaryKey(),
    decisionId: uuid("decision_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    input: bigint("input", { mode: "number" }).notNull(),
    cacheRead: bigint("cache_read", { mode: "number" }).notNull(),
    /** All cache writes; `cache_write_1h` is the subset written with a 1h TTL. */
    cacheWrite: bigint("cache_write", { mode: "number" }).notNull(),
    cacheWrite1h: bigint("cache_write_1h", { mode: "number" }).notNull(),
    output: bigint("output", { mode: "number" }).notNull(),
    estimated: boolean("estimated").notNull(),
  },
  (table) => [
    index("routing_usage_decision_id_idx").on(table.decisionId),
    index("routing_usage_created_at_idx").on(table.createdAt),
  ],
);

export default routingUsageTable;
