import {
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import type { CommonToolCall, CommonToolResult } from "@/types";
import agentsTable from "./agent";
import conversationsTable from "./conversation";
import usersTable from "./user";

export type McpToolExecutionStatus = "executing" | "completed" | "failed";

const mcpToolExecutionsTable = pgTable(
  "mcp_tool_executions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    toolCallId: text("tool_call_id").notNull(),
    agentId: uuid("agent_id").references(() => agentsTable.id, {
      onDelete: "set null",
    }),
    conversationId: uuid("conversation_id").references(
      () => conversationsTable.id,
      { onDelete: "cascade" },
    ),
    userId: text("user_id").references(() => usersTable.id, {
      onDelete: "set null",
    }),
    toolName: varchar("tool_name", { length: 255 }).notNull(),
    status: text("status")
      .$type<McpToolExecutionStatus>()
      .notNull()
      .default("executing"),
    toolCall: jsonb("tool_call").$type<CommonToolCall | null>(),
    toolResult: jsonb("tool_result").$type<CommonToolResult | null>(),
    error: text("error"),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "date" })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => ({
    toolCallIdIdx: uniqueIndex("mcp_tool_executions_tool_call_id_uidx").on(
      table.toolCallId,
    ),
    agentIdIdx: index("mcp_tool_executions_agent_id_idx").on(table.agentId),
    conversationIdIdx: index("mcp_tool_executions_conversation_id_idx").on(
      table.conversationId,
    ),
    statusUpdatedAtIdx: index("mcp_tool_executions_status_updated_at_idx").on(
      table.status,
      table.updatedAt,
    ),
  }),
);

export default mcpToolExecutionsTable;
