import { type UIMessage } from 'ai';
import { sql } from 'drizzle-orm';
import { index, int, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { createSelectSchema } from 'drizzle-zod';
import { z } from 'zod';

import { chatsTable } from './chat';

export const ChatMessageRoleSchema = z.enum(['user', 'assistant', 'system']);

export const messagesTable = sqliteTable(
  'messages',
  {
    id: int().primaryKey({ autoIncrement: true }),
    chatId: int()
      .notNull()
      .references(() => chatsTable.id, { onDelete: 'cascade' }),
    role: text().$type<z.infer<typeof ChatMessageRoleSchema>>().notNull(),
    /**
     * Content stores the entire UIMessage object from the 'ai' SDK
     */
    content: text({ mode: 'json' }).$type<UIMessage>().notNull(),
    createdAt: text()
      .notNull()
      .default(sql`(current_timestamp)`),
  },
  (table) => ({
    chatIdIdx: index('messages_chat_id_idx').on(table.chatId),
    chatIdCreatedAtIdx: index('messages_chat_id_created_at_idx').on(table.chatId, table.createdAt),
  })
);

/**
 * TODO: this is kinda a hack to get the outputted zod (and thereby openapi spec) to be 100% correct...
 */
export const SelectMessagesSchema = createSelectSchema(messagesTable).extend({
  role: ChatMessageRoleSchema,
});
