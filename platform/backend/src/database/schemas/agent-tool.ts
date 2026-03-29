import { pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import type { CredentialResolutionMode } from "@/types";
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
    // Static assignments pin a tool to one installed MCP server.
    // Remote tools use it as the credential-bearing installation; local tools use it
    // as the execution target. Dynamic and enterprise-managed assignments leave it null.
    mcpServerId: uuid("mcp_server_id").references(() => mcpServerTable.id, {
      onDelete: "set null",
    }),
    credentialResolutionMode: text("credential_resolution_mode")
      .$type<CredentialResolutionMode>()
      .notNull()
      .default("static"),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "date" })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [unique().on(table.agentId, table.toolId)],
);

export default agentToolsTable;
