import { sql } from "drizzle-orm";
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
import secretsTable from "./secret";

/**
 * One messaging bot identity: a Slack App (one bot user token), or the single
 * org-level Microsoft Teams / Telegram bot.
 *
 * Every channel binding, message receipt and per-thread state entry belongs to
 * exactly one bot, so two bots in the same workspace never share state. The
 * credentials live in the referenced secret (same shape the singleton provider
 * configs used); the external identity columns are verified against the
 * provider on first setup and then pinned.
 */
const chatopsBotsTable = pgTable(
  "chatops_bots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Organization that owns this bot */
    organizationId: text("organization_id").notNull(),
    /** Chatops provider type (ms-teams, slack, telegram) */
    provider: varchar("provider", { length: 32 })
      .$type<ChatOpsProviderType>()
      .notNull(),
    /** Display name shown in Settings and on agent cards (e.g. the Slack App name) */
    name: varchar("name", { length: 256 }).notNull(),
    /** Credentials and transport settings for this bot */
    secretId: uuid("secret_id").references(() => secretsTable.id, {
      onDelete: "set null",
    }),
    /** Provider-side app id (Slack `A…`), pinned once verified */
    externalAppId: varchar("external_app_id", { length: 64 }),
    /** Provider-side workspace id (Slack `T…`), pinned once verified */
    externalWorkspaceId: varchar("external_workspace_id", { length: 64 }),
    /** Provider-side bot user id (Slack `U…`), pinned once verified */
    externalBotUserId: varchar("external_bot_user_id", { length: 64 }),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "date" })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    index("chatops_bots_organization_provider_idx").on(
      table.organizationId,
      table.provider,
    ),
    // A workspace's bot user belongs to one bot only. Bots that have not been
    // verified yet carry NULLs, which never collide.
    uniqueIndex("chatops_bots_identity_idx").on(
      table.organizationId,
      table.provider,
      table.externalWorkspaceId,
      table.externalBotUserId,
    ),
    // Microsoft Teams and Telegram keep a single org-level bot; only Slack can
    // hold several.
    uniqueIndex("chatops_bots_single_bot_provider_idx")
      .on(table.organizationId, table.provider)
      .where(sql`${table.provider} <> 'slack'`),
  ],
);

export default chatopsBotsTable;
