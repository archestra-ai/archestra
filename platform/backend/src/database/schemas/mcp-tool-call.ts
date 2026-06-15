import {
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import type {
  CommonToolCall,
  MCPGatewayAuthMethod,
  ToolOwnerType,
} from "@/types";
import agentsTable from "./agent";
import appsTable from "./app";
import usersTable from "./user";

// Note: Additional pg_trgm GIN indexes for search are created in migration 0116_pg_trgm_indexes.sql:
// - mcp_tool_calls_method_trgm_idx: GIN index on method column
// - mcp_tool_calls_mcp_server_name_trgm_idx: GIN index on mcp_server_name column
// - mcp_tool_calls_tool_result_trgm_idx: GIN index on (tool_result::text)
const mcpToolCallsTable = pgTable(
  "mcp_tool_calls",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Which owner kind made the call. Defaults to "agent" so existing rows and
    // unchanged agent call sites stay correct; app calls set it to "app".
    ownerType: varchar("owner_type", { length: 16 })
      .$type<ToolOwnerType>()
      .notNull()
      .default("agent"),
    // Nullable to preserve MCP tool calls when the agent is deleted
    // (null agent_id on an agent-owned row indicates the agent was deleted).
    agentId: uuid("agent_id").references(() => agentsTable.id, {
      onDelete: "set null",
    }),
    // Set for app-owned calls; nullable, and set null if the app is deleted.
    appId: uuid("app_id").references(() => appsTable.id, {
      onDelete: "set null",
    }),
    mcpServerName: varchar("mcp_server_name", { length: 255 }).notNull(),
    method: varchar("method", { length: 255 }).notNull(),
    toolCall: jsonb("tool_call").$type<CommonToolCall | null>(),
    // toolResult structure varies by method type:
    // - tools/call: { id, content, isError, error? }
    // - tools/list: { tools: [...] }
    // - initialize: { capabilities, serverInfo }
    toolResult: jsonb("tool_result").$type<unknown>(),
    userId: text("user_id").references(() => usersTable.id, {
      onDelete: "set null",
    }),
    authMethod: varchar("auth_method", {
      length: 50,
    }).$type<MCPGatewayAuthMethod>(),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  },
  (table) => ({
    agentIdIdx: index("mcp_tool_calls_agent_id_idx").on(table.agentId),
    appIdIdx: index("mcp_tool_calls_app_id_idx").on(table.appId),
    createdAtIdx: index("mcp_tool_calls_created_at_idx").on(table.createdAt),
  }),
);

export default mcpToolCallsTable;
