import {
  index,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import toolsTable from "./tool";
import usersTable from "./user";

/**
 * Who observed a tool in LLM proxy traffic, and through which client app.
 * One row per (tool, user, client) — written by the proxy's tool-discovery
 * path so the guardrails page can narrow observed tools to "this user's
 * tools from this client". `externalAgentId` holds the client-attribution id
 * recorded on interactions (e.g. "anthropic_claude_code"); "" when the
 * request carried no client attribution.
 */
const toolObservationsTable = pgTable(
  "tool_observations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    toolId: uuid("tool_id")
      .notNull()
      .references(() => toolsTable.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    externalAgentId: text("external_agent_id").notNull().default(""),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    unique().on(table.toolId, table.userId, table.externalAgentId),
    index("tool_observations_user_client_idx").on(
      table.userId,
      table.externalAgentId,
    ),
  ],
);

export default toolObservationsTable;
