import {
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import type { ChatOpsProviderType } from "@/types/chatops";
import promptsTable from "./prompt";

/**
 * Maps chatops channels (Teams, Slack, etc.) to Archestra prompts (agents in UI).
 *
 * Each channel can have one binding to a prompt. When a message arrives
 * in the channel, it is routed to the bound prompt for processing via A2A.
 *
 * Unique constraint on (provider, channelId, workspaceId) ensures
 * one binding per channel.
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
    /** Channel ID from the provider (e.g., Teams channel ID) */
    channelId: varchar("channel_id", { length: 256 }).notNull(),
    /** Workspace/Team ID from the provider (e.g., Teams team ID) */
    workspaceId: varchar("workspace_id", { length: 256 }),
    /** The prompt (agent in UI) to route messages to */
    promptId: uuid("prompt_id")
      .notNull()
      .references(() => promptsTable.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "date" })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    // Unique constraint: one binding per channel per provider
    uniqueIndex("chatops_channel_binding_provider_channel_workspace_idx").on(
      table.provider,
      table.channelId,
      table.workspaceId,
    ),
    // Index for looking up bindings by organization
    index("chatops_channel_binding_organization_id_idx").on(
      table.organizationId,
    ),
    // Index for looking up bindings by prompt
    index("chatops_channel_binding_prompt_id_idx").on(table.promptId),
  ],
);

export default chatopsChannelBindingsTable;
