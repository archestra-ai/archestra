import {
  index,
  pgTable,
  primaryKey,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import agentsTable from "./agent";
import chatopsBotsTable from "./chatops-bot";

/**
 * The bots an agent speaks through: one row is one card on the agent's
 * Messaging tab. An agent can hold a card for a bot without any channel yet.
 *
 * A Slack App that sits on exactly one agent's card is that agent's dedicated
 * bot: messages the bot receives in channels or DMs nobody assigned resolve to
 * that agent. An agent uses one bot per provider at a time (enforced by the
 * service that writes this table, not by the schema, so it can be lifted later).
 */
const agentChatopsBotsTable = pgTable(
  "agent_chatops_bots",
  {
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agentsTable.id, { onDelete: "cascade" }),
    botId: uuid("bot_id")
      .notNull()
      .references(() => chatopsBotsTable.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.agentId, table.botId] }),
    index("agent_chatops_bots_bot_id_idx").on(table.botId),
  ],
);

export default agentChatopsBotsTable;
