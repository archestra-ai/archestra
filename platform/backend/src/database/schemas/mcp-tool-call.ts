import {
  index,
  jsonb,
  pgTable,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import type { CommonToolCall, CommonToolResult } from "@/types";
import agentsTable from "./agent";

const mcpToolCallsTable = pgTable(
  "mcp_tool_calls",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agentsTable.id, { onDelete: "cascade" }),
    mcpServerName: varchar("mcp_server_name", { length: 255 }).notNull(),
    toolCall: jsonb("tool_call").$type<CommonToolCall>().notNull(),
    toolResult: jsonb("tool_result").$type<CommonToolResult>().notNull(),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  },
  (table) => ({
    agentIdIdx: index("mcp_tool_calls_agent_id_idx").on(table.agentId),
    createdAtIdx: index("mcp_tool_calls_created_at_idx").on(table.createdAt),
  }),
);

export default mcpToolCallsTable;
