import { sql } from 'drizzle-orm';
import { int, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { createSelectSchema } from 'drizzle-zod';

import { userTable } from './user';

export const memoryTable = sqliteTable(
  'memory_entries',
  {
    id: int().primaryKey({ autoIncrement: true }),
    userId: int()
      .notNull()
      .references(() => userTable.id, { onDelete: 'cascade' }),
    name: text().notNull(),
    value: text().notNull().default(''),
    createdAt: text()
      .notNull()
      .default(sql`(current_timestamp)`),
    updatedAt: text()
      .notNull()
      .default(sql`(current_timestamp)`),
  },
  (table) => ({
    // Ensure unique name per user
    userNameIdx: uniqueIndex('user_name_idx').on(table.userId, table.name),
  })
);

export const SelectMemorySchema = createSelectSchema(memoryTable);
