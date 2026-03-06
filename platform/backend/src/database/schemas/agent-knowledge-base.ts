import {
  index,
  pgTable,
  primaryKey,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import agentsTable from "./agent";
import knowledgeBasesTable from "./knowledge-base";

const agentKnowledgeBasesTable = pgTable(
  "agent_knowledge_base",
  {
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agentsTable.id, { onDelete: "cascade" }),
    knowledgeBaseId: uuid("knowledge_base_id")
      .notNull()
      .references(() => knowledgeBasesTable.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.agentId, table.knowledgeBaseId] }),
    index("agent_knowledge_base_agent_idx").on(table.agentId),
    index("agent_knowledge_base_kb_idx").on(table.knowledgeBaseId),
  ],
);

export default agentKnowledgeBasesTable;
