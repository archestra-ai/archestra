import {
  index,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import chatopsChannelBindingsTable from "./chatops-channel-binding";
import conversationsTable from "./conversation";

/**
 * Maps a ChatOps thread (Slack thread / Teams reply chain / Telegram chat) to
 * its persisted chat conversation, making the conversation the canonical
 * cross-interface history for the thread.
 *
 * threadId is the canonical effective thread id — the same
 * `message.threadId ?? message.channelId ?? message.messageId` fallback chain
 * used for ChatOps sessions and thread agent overrides — so providers without
 * native threads (Telegram non-topic chats, DMs) map consistently.
 *
 * Creation follows the scheduled-run CAS pattern: create the conversation,
 * then insert the mapping with ON CONFLICT DO NOTHING; a losing racer deletes
 * its orphan conversation and adopts the winner's.
 */
const chatopsThreadConversationsTable = pgTable(
  "chatops_thread_conversations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** FK to the channel binding this thread belongs to */
    bindingId: uuid("binding_id")
      .notNull()
      .references(() => chatopsChannelBindingsTable.id, {
        onDelete: "cascade",
      }),
    /** Canonical effective thread id (see module doc) */
    threadId: varchar("thread_id", { length: 256 }).notNull(),
    /** The persisted conversation backing this thread */
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversationsTable.id, { onDelete: "cascade" }),
    /**
     * High-water mark of provider thread messages already ingested into the
     * conversation (provider-native ordering token, e.g. Slack ts). Advanced
     * only by compare-and-set under the conversation's active-run lock.
     */
    lastSyncedProviderTs: varchar("last_synced_provider_ts", { length: 256 }),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "date" })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    // One conversation per thread per binding
    uniqueIndex("chatops_thread_conversations_binding_thread_idx").on(
      table.bindingId,
      table.threadId,
    ),
    // Reverse lookup + cleanup when a conversation is deleted
    index("chatops_thread_conversations_conversation_id_idx").on(
      table.conversationId,
    ),
  ],
);

export default chatopsThreadConversationsTable;
