import {
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import a2aContextTable from "./a2a-context";
import a2aMessageTable from "./a2a-message";

/**
 * Persisted cross-turn compaction summaries for A2A contexts, mirroring
 * `conversation_compactions` for web chat. When a stateful A2A context's
 * accumulated history approaches the model's context window, the older prefix
 * is summarized once and stored here; subsequent turns load the summary plus
 * the messages after `boundary_message_id` instead of the full history.
 *
 * The boundary references the last `a2a_message` covered by the summary. It
 * cascades with the message row: if history is ever pruned, the stale summary
 * disappears with it rather than pointing into nothing.
 */
const a2aContextCompactionsTable = pgTable(
  "a2a_context_compactions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    contextId: uuid("context_id")
      .notNull()
      .references(() => a2aContextTable.id, { onDelete: "cascade" }),
    summary: text("summary").notNull(),
    /** Last a2a_message covered by the summary. */
    boundaryMessageId: uuid("boundary_message_id")
      .notNull()
      .references(() => a2aMessageTable.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    originalTokenEstimate: integer("original_token_estimate").notNull(),
    compactedTokenEstimate: integer("compacted_token_estimate").notNull(),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    index("a2a_context_compactions_context_id_created_at_idx").on(
      table.contextId,
      table.createdAt,
    ),
  ],
);

export default a2aContextCompactionsTable;
