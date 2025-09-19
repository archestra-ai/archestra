import { sql } from 'drizzle-orm';
import { index, int, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { createSelectSchema } from 'drizzle-zod';

export const chatsTable = sqliteTable(
  'chats',
  {
    id: int().primaryKey({ autoIncrement: true }),
    sessionId: text()
      .notNull()
      .unique()
      .default(
        sql`(lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab',abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6))))`
      ),
    title: text(),
    /**
     * Array of tool IDs that are selected/enabled for this chat.
     * If null, all available tools are enabled (default behavior).
     * Format: JSON array of tool IDs like ["mcp_server_id__tool_name", ...]
     */
    selectedTools: text({ mode: 'json' }).$type<string[] | null>(),
    /**
     * Token usage tracking for the entire chat session
     */
    totalPromptTokens: int('total_prompt_tokens').default(0),
    totalCompletionTokens: int('total_completion_tokens').default(0),
    totalTokens: int('total_tokens').default(0),
    lastModel: text('last_model'),
    lastContextWindow: int('last_context_window'),
    createdAt: text()
      .notNull()
      .default(sql`(current_timestamp)`),
    updatedAt: text()
      .notNull()
      .default(sql`(current_timestamp)`),
  },
  (table) => ({
    createdAtIdx: index('chats_created_at_idx').on(table.createdAt),
  })
);

export const SelectChatSchema = createSelectSchema(chatsTable);
