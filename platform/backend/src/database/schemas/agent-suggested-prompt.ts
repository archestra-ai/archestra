import {
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import agentsTable from "./agent";

const agentSuggestedPromptsTable = pgTable(
  "agent_suggested_prompts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agentsTable.id, { onDelete: "cascade" }),
    /** Short title shown on the suggestion button */
    summaryTitle: text("summary_title").notNull(),
    /** The full prompt text sent when the suggestion is clicked */
    prompt: text("prompt").notNull(),
    /** Display order (lower = first) */
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "date" })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [index("agent_suggested_prompts_agent_id_idx").on(table.agentId)],
);

export default agentSuggestedPromptsTable;
