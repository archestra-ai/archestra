import {
  index,
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

const toolsTable = pgTable(
  "tools",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** @deprecated No longer set by any code path. All tool-to-agent links use the agent_tools junction table. Will be dropped in a future migration. */
    agentId: uuid("agent_id").references(() => agentsTable.id, {
      onDelete: "cascade",
    }),
    // catalogId links MCP tools to their catalog item (shared across installations)
    // null for proxy-sniffed tools
    catalogId: uuid("catalog_id").references(() => mcpCatalogTable.id, {
      onDelete: "cascade",
    }),
    // delegateToAgentId links delegation tools directly to their target agent
    // When set, the tool is a delegation tool that forwards requests to the target agent
    // Used by internal agents for agent-to-agent delegation
    delegateToAgentId: uuid("delegate_to_agent_id").references(
      () => agentsTable.id,
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
    meta: jsonb("meta").$type<Record<string, unknown>>(),
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
    policiesAutoConfiguredModel: text("policies_auto_configured_model"),
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
    // - For delegation tools: one tool per delegateToAgentId
    unique().on(
      table.catalogId,
      table.name,
      table.agentId,
      table.delegateToAgentId,
    ),
    // Index for delegation tool lookups
    index("tools_delegate_to_agent_id_idx").on(table.delegateToAgentId),
  ],
);

export default toolsTable;
