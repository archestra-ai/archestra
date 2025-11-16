import {
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import type { DualLlmMessage } from "@/types";
import agentsTable from "./agent";

/**
 * Stores results from the Dual LLM Quarantine Pattern
 * Records the Q&A conversation and safe summary for each tool call
 */
const dualLlmResultsTable = pgTable(
  "dual_llm_results",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agentsTable.id, { onDelete: "cascade" }),
    toolCallId: text("tool_call_id").notNull(),
    conversations: jsonb("conversations").$type<DualLlmMessage[]>().notNull(),
    result: text("result").notNull(),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  },
  (table) => ({
    agentIdIdx: index("dual_llm_results_agent_id_idx").on(table.agentId),
  }),
);

export default dualLlmResultsTable;
