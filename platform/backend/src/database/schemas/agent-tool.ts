import { pgTable, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import agentsTable from "./agent";
import mcpServerTable from "./mcp-server";
import toolsTable from "./tool";
import toolPoliciesTable from "./tool-policy";

const agentToolsTable = pgTable(
  "agent_tools",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agentsTable.id, { onDelete: "cascade" }),
    toolId: uuid("tool_id")
      .notNull()
      .references(() => toolsTable.id, { onDelete: "cascade" }),
    toolPolicyId: uuid("tool_policy_id").references(
      () => toolPoliciesTable.id,
      {
        onDelete: "set null",
      },
    ),
    credentialSourceMcpServerId: uuid(
      "credential_source_mcp_server_id",
    ).references(() => mcpServerTable.id, { onDelete: "set null" }),
    // executionSourceMcpServerId specifies which MCP server pod to route tool calls to
    // Used for local MCP servers to choose between multiple installations of same catalog
    executionSourceMcpServerId: uuid(
      "execution_source_mcp_server_id",
    ).references(() => mcpServerTable.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "date" })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [unique().on(table.agentId, table.toolId)],
);

export default agentToolsTable;
