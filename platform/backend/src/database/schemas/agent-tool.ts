import {
  boolean,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import type { ToolResultTreatment } from "@/types";
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
    allowUsageWhenUntrustedDataIsPresent: boolean(
      "allow_usage_when_untrusted_data_is_present",
    )
      .notNull()
      .default(false),
    toolResultTreatment: text("tool_result_treatment")
      .$type<ToolResultTreatment>()
      .notNull()
      .default("untrusted"),
    responseModifierTemplate: text("response_modifier_template"),
    credentialSourceMcpServerId: uuid(
      "credential_source_mcp_server_id",
    ).references(() => mcpServerTable.id, { onDelete: "set null" }),
    // executionSourceMcpServerId specifies which MCP server pod to route tool calls to
    // Used for local MCP servers to choose between multiple installations of same catalog
    executionSourceMcpServerId: uuid(
      "execution_source_mcp_server_id",
    ).references(() => mcpServerTable.id, { onDelete: "set null" }),
    // When true, credential is resolved dynamically based on the bearer token's team at runtime
    // Instead of using credentialSourceMcpServerId, finds matching team credential
    useDynamicTeamCredential: boolean("use_dynamic_team_credential")
      .notNull()
      .default(false),
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
  (table) => [unique().on(table.agentId, table.toolId)],
);

export default agentToolsTable;
