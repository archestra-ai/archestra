import {
  boolean,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import agentsTable from "./agent";
import mcpServerTable from "./mcp-server";
import toolsTable from "./tool";

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
    responseModifierTemplate: text("response_modifier_template"),
    // credentialSourceMcpServerId specifies which !!!REMOTE!!! MCP server to use for credentials
    credentialSourceMcpServerId: uuid(
      "credential_source_mcp_server_id",
    ).references(() => mcpServerTable.id, { onDelete: "set null" }),
    // executionSourceMcpServerId specifies which MCP server Deployment to route tool calls to
    // Used for local MCP servers to choose between multiple installations of same catalog
    executionSourceMcpServerId: uuid(
      "execution_source_mcp_server_id",
    ).references(() => mcpServerTable.id, { onDelete: "set null" }),
    // When true, credential is resolved dynamically based on the bearer token's team at runtime
    // Instead of using credentialSourceMcpServerId, finds matching team credential
    useDynamicTeamCredential: boolean("use_dynamic_team_credential")
      .notNull()
      .default(false),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "date" })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [unique().on(table.agentId, table.toolId)],
);

export default agentToolsTable;
