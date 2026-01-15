import {
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import type { ToolParametersContent } from "@/types";
import agentsTable from "./agent";
import mcpCatalogTable from "./internal-mcp-catalog";
import mcpServerTable from "./mcp-server";
import promptAgentsTable from "./prompt-agent";

const toolsTable = pgTable(
  "tools",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // agentId is nullable - null for MCP tools, set for proxy-sniffed tools
    agentId: uuid("agent_id").references(() => agentsTable.id, {
      onDelete: "cascade",
    }),
    // catalogId links MCP tools to their catalog item (shared across installations)
    // null for proxy-sniffed tools
    catalogId: uuid("catalog_id").references(() => mcpCatalogTable.id, {
      onDelete: "cascade",
    }),
    // mcpServerId indicates which MCP server discovered this tool (metadata)
    // null for proxy-sniffed tools or if the discovering server was deleted
    mcpServerId: uuid("mcp_server_id").references(() => mcpServerTable.id, {
      onDelete: "set null",
    }),
    // promptAgentId links agent delegation tools to their prompt_agent relationship
    // null for MCP tools, Archestra tools, and proxy-sniffed tools
    // When set, the tool is a prompt-specific agent delegation tool (NOT in agent_tools)
    promptAgentId: uuid("prompt_agent_id").references(
      () => promptAgentsTable.id,
      {
        onDelete: "cascade",
      },
    ),
    name: text("name").notNull(),
    parameters: jsonb("parameters")
      .$type<ToolParametersContent>()
      .notNull()
      .default({}),
    description: text("description"),
    policiesAutoConfiguredAt: timestamp("policies_auto_configured_at", {
      mode: "date",
    }),
    policiesAutoConfiguringStartedAt: timestamp(
      "policies_auto_configuring_started_at",
      {
        mode: "date",
      },
    ),
    policiesAutoConfiguredReasoning: text("policies_auto_configured_reasoning"),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "date" })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    // Unique constraint ensures:
    // - For MCP tools: one tool per (catalogId, name) combination
    // - For proxy-sniffed tools: one tool per (agentId, name) combination
    // - For agent delegation tools: one tool per promptAgentId
    unique().on(
      table.catalogId,
      table.name,
      table.agentId,
      table.promptAgentId,
    ),
  ],
);

export default toolsTable;
