import { pgTable, primaryKey, uuid } from "drizzle-orm/pg-core";
import conversationsTable from "./conversation";
import toolsTable from "./tool";

const conversationEnabledToolsTable = pgTable(
  "conversation_enabled_tools",
  {
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversationsTable.id, { onDelete: "cascade" }),
    toolId: uuid("tool_id")
      .notNull()
      .references(() => toolsTable.id, { onDelete: "cascade" }),
  },
  (table) => [primaryKey({ columns: [table.conversationId, table.toolId] })],
);

export default conversationEnabledToolsTable;
