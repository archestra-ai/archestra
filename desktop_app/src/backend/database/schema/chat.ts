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
