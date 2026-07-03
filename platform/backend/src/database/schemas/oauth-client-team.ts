import {
  index,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import oauthClient from "./oauth-client";
import { team } from "./team";

/**
 * Junction table between OAuth clients and teams. Mirrors `agent_team` /
 * `virtual_api_key_team`. Shared by MCP gateway OAuth clients
 * (`metadata.type = "mcp_oauth_client"`) and LLM proxy OAuth clients
 * (`metadata.type = "llm_oauth_client"`), which both live in the
 * `oauth_client` table. Rows are only consulted for `team`-scoped clients.
 */
const oauthClientTeamsTable = pgTable(
  "oauth_client_team",
  {
    oauthClientId: text("oauth_client_id")
      .notNull()
      .references(() => oauthClient.id, { onDelete: "cascade" }),
    teamId: text("team_id")
      .notNull()
      .references(() => team.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.oauthClientId, table.teamId] }),
    teamIdIdx: index("idx_oauth_client_team_team_id").on(table.teamId),
  }),
);

export default oauthClientTeamsTable;
