import {
  boolean,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import type { ChatOpsProviderType } from "@/types/chatops";
import agentsTable from "./agent";
import chatopsBotsTable from "./chatops-bot";

/**
 * Maps chatops channels (Teams, Slack, etc.) to Archestra agents.
 *
 * Each channel can have one binding to an agent. When a message arrives
 * in the channel, it is routed to the assigned agent for processing via A2A.
 *
 * Bindings belong to one bot (Slack App, Teams bot, Telegram bot). Two bots
 * in the same channel hold two bindings, each with its own agent assignment.
 *
 * Unique constraint on (botId, channelId, workspaceId) ensures one assignment
 * per channel per bot.
 */
const chatopsChannelBindingsTable = pgTable(
  "chatops_channel_binding",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Organization that owns this binding */
    organizationId: text("organization_id").notNull(),
    /** Chatops provider type (ms-teams, slack, discord) */
    provider: varchar("provider", { length: 32 })
      .$type<ChatOpsProviderType>()
      .notNull(),
    /** The bot whose membership created this binding */
    botId: uuid("bot_id")
      .notNull()
      .references(() => chatopsBotsTable.id, { onDelete: "cascade" }),
    /** Channel ID from the provider (e.g., Teams channel ID) */
    channelId: varchar("channel_id", { length: 256 }).notNull(),
    /** Workspace/Team ID from the provider (e.g., Teams team ID) */
    workspaceId: varchar("workspace_id", { length: 256 }),
    /** Human-readable channel name (resolved via TeamsInfo) */
    channelName: varchar("channel_name", { length: 256 }),
    /** Human-readable workspace/team name (resolved via TeamsInfo) */
    workspaceName: varchar("workspace_name", { length: 256 }),
    /** Whether this binding is for a direct message conversation */
    isDm: boolean("is_dm").notNull().default(false),
    /**
     * When true, the bot replies to every message in this channel, not only to
     * messages that @mention it. Defaults to false (mentions-only). Ignored for
     * DM bindings, which always reply.
     */
    answerAllMessages: boolean("answer_all_messages").notNull().default(false),
    /**
     * Free-text instructions an admin writes for this channel. They are handed
     * to the model with every message the channel routes to its agent — never
     * baked into the agent's system prompt — so one agent can behave
     * differently per channel. Null or empty means no channel instructions.
     */
    channelInstructions: text("channel_instructions"),
    /** Email of the user who owns this DM binding (null for channel bindings) */
    dmOwnerEmail: varchar("dm_owner_email", { length: 256 }),
    /** The internal agent to route messages to */
    agentId: uuid("agent_id").references(() => agentsTable.id, {
      onDelete: "cascade",
    }),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "date" })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    // Unique constraint: one binding per channel per bot
    uniqueIndex("chatops_channel_binding_bot_channel_workspace_idx").on(
      table.botId,
      table.channelId,
      table.workspaceId,
    ),
    // Index for looking up bindings by provider (status, discovery cleanup)
    index("chatops_channel_binding_provider_idx").on(table.provider),
    // Index for looking up bindings by organization
    index("chatops_channel_binding_organization_id_idx").on(
      table.organizationId,
    ),
    // Index for looking up bindings by agent
    index("chatops_channel_binding_agent_id_idx").on(table.agentId),
  ],
);

export default chatopsChannelBindingsTable;
