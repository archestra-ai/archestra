import { pgTable, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import promptsTable from "./prompt";

/**
 * Junction table for prompt-to-agent (child prompt) relationships.
 * Each prompt can have multiple agents (other prompts) that it can delegate tasks to.
 */
const promptAgentsTable = pgTable(
  "prompt_agents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    promptId: uuid("prompt_id")
      .notNull()
      .references(() => promptsTable.id, { onDelete: "cascade" }),
    agentPromptId: uuid("agent_prompt_id")
      .notNull()
      .references(() => promptsTable.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("prompt_agent_unique").on(table.promptId, table.agentPromptId),
  ],
);

export default promptAgentsTable;
