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
import mcpServerTable from "./mcp-server";

const toolsTable = pgTable(
  "tools",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // agentId is nullable - null for MCP tools, set for proxy-sniffed tools
    agentId: uuid("agent_id").references(() => agentsTable.id, {
      onDelete: "cascade",
    }),
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
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "date" })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [unique().on(table.agentId, table.name)],
);

export default toolsTable;
