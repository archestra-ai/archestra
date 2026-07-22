import {
  index,
  pgTable,
  timestamp,
  unique,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import type { ChatOpsProviderType } from "@/types/chatops";
import a2aContextTable from "./a2a-context";

/**
 * Maps a chatops conversation thread to its persistent A2A context.
 *
 * Providers whose platform API cannot return chat history (Telegram) keep the
 * conversation server-side instead: each thread gets one A2A context whose
 * messages accumulate across turns, so the agent remembers the conversation.
 * The thread key mirrors the effective thread id used for LLM session
 * grouping — the provider thread id, falling back to the channel id for
 * non-threaded chats (Telegram DMs and plain groups).
 *
 * `nullsNotDistinct` keeps the key unique for providers without a workspace
 * dimension (Telegram's workspaceId is always null).
 */
const chatopsThreadContextsTable = pgTable(
  "chatops_thread_contexts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    provider: varchar("provider", { length: 32 })
      .$type<ChatOpsProviderType>()
      .notNull(),
    channelId: varchar("channel_id", { length: 256 }).notNull(),
    workspaceId: varchar("workspace_id", { length: 256 }),
    threadId: varchar("thread_id", { length: 256 }).notNull(),
    contextId: uuid("context_id")
      .notNull()
      .references(() => a2aContextTable.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    unique("chatops_thread_contexts_thread_key_uq")
      .on(table.provider, table.channelId, table.workspaceId, table.threadId)
      .nullsNotDistinct(),
    index("chatops_thread_contexts_context_id_idx").on(table.contextId),
  ],
);

export default chatopsThreadContextsTable;
