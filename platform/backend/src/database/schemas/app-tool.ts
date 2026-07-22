import { pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import type { CredentialResolutionMode } from "@/types";
import appsTable from "./app";
import mcpServerTable from "./mcp-server";
import toolsTable from "./tool";

/**
 * Tools attached to an app. Mirrors `agent_tools`: the app is the owner instead
 * of an agent. Covers App Data Store tools, Archestra built-ins, and upstream
 * MCP-server tools the app is allowed to call.
 */
const appToolsTable = pgTable(
  "app_tools",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    appId: uuid("app_id")
      .notNull()
      .references(() => appsTable.id, { onDelete: "cascade" }),
    toolId: uuid("tool_id")
      .notNull()
      .references(() => toolsTable.id, { onDelete: "cascade" }),
    // Static assignments pin a tool to one installed MCP server (the
    // credential-bearing installation for remote tools, the execution target
    // for local tools). Dynamic/enterprise-managed assignments leave it null.
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
  (table) => [unique().on(table.appId, table.toolId)],
);

export default appToolsTable;
