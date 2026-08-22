import {
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import mcpServerTable from "./mcp-server";

/**
 * Append-only activation log for Skills projected from installed MCP servers.
 * The source identity is the concrete installation plus Skill URI: catalog
 * metadata can be refreshed or replaced, while two installations serving the
 * same URI remain distinct origins with distinct credentials and visibility.
 */
const externalMcpSkillUsageEventsTable = pgTable(
  "external_mcp_skill_usage_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    mcpServerId: uuid("mcp_server_id")
      .notNull()
      .references(() => mcpServerTable.id, { onDelete: "cascade" }),
    uri: text("uri").notNull(),
    /**
     * Deliberately not a foreign key: token contexts may use synthetic user
     * ids, and usage history must survive user deletion.
     */
    userId: text("user_id"),
    sessionId: text("session_id"),
    contextTokens: integer("context_tokens"),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    index("external_skill_usage_server_uri_created_idx").on(
      table.mcpServerId,
      table.uri,
      table.createdAt,
    ),
  ],
);

export default externalMcpSkillUsageEventsTable;
