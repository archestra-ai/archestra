import { sql } from 'drizzle-orm';
import { int, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { createSelectSchema } from 'drizzle-zod';

export const userTable = sqliteTable('user', {
  id: int().primaryKey({ autoIncrement: true }),
  uniqueId: text().unique(),
  hasCompletedOnboarding: int({ mode: 'boolean' }).notNull().default(false),
  collectTelemetryData: int({ mode: 'boolean' }).notNull().default(true),
  collectAnalyticsData: int({ mode: 'boolean' }).notNull().default(true),
  createdAt: text()
    .notNull()
    .default(sql`(current_timestamp)`),
  updatedAt: text()
    .notNull()
    .default(sql`(current_timestamp)`),
});

export const SelectUserSchema = createSelectSchema(userTable);
