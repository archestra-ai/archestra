import {
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import mcpServerTable from "./mcp-server";
import { team } from "./team";

/**
 * McpServerTeam table - many-to-many relationship between MCP servers and teams
 * For team-based authorization of MCP server installations
 */
const mcpServerTeamTable = pgTable(
  "mcp_server_team",
  {
    mcpServerId: uuid("mcp_server_id")
      .notNull()
      .references(() => mcpServerTable.id, { onDelete: "cascade" }),
    teamId: text("team_id")
      .notNull()
      .references(() => team.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.mcpServerId, table.teamId] }),
  }),
);

export default mcpServerTeamTable;
