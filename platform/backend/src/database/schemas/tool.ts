import {
  boolean,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import type {
  ToolParametersContent,
  ToolResultTreatment,
  ToolSource,
} from "@/types";
import agentsTable from "./agent";
import mcpServerTable from "./mcp-server";

const toolsTable = pgTable(
  "tools",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // agentId is nullable - null for MCP tools, set for proxy-sniffed tools
    agentId: uuid("agent_id").references(() => agentsTable.id, {
      onDelete: "cascade",
    }),
    // source indicates where the tool came from
    source: text("source").$type<ToolSource>().notNull().default("proxy"),
    // mcpServerId is set for MCP tools, null for proxy-sniffed tools
    mcpServerId: uuid("mcp_server_id").references(() => mcpServerTable.id, {
      onDelete: "cascade",
    }),
    name: text("name").notNull(),
    parameters: jsonb("parameters")
      .$type<ToolParametersContent>()
      .notNull()
      .default({}),
    description: text("description"),
    allowUsageWhenUntrustedDataIsPresent: boolean(
      "allow_usage_when_untrusted_data_is_present",
    )
      .notNull()
      .default(false),
    toolResultTreatment: text("tool_result_treatment")
      .$type<ToolResultTreatment>()
      .notNull()
      .default("untrusted"),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "date" })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [unique().on(table.agentId, table.name)],
);

export default toolsTable;
