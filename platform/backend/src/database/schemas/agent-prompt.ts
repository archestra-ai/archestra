import { integer, pgTable, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import agentsTable from "./agent";
import promptsTable from "./prompt";

const agentPromptsTable = pgTable(
  "agent_prompts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agentsTable.id, { onDelete: "cascade" }),
    promptId: uuid("prompt_id")
      .notNull()
      .references(() => promptsTable.id, { onDelete: "cascade" }),
    order: integer("order").notNull().default(0),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  },
  (table) => ({
    uniqueAgentPrompt: unique().on(table.agentId, table.promptId),
  }),
);

export default agentPromptsTable;
