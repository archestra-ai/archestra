import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

/** Committed atomically with each application-level data upgrade. */
const startupMigrationsTable = pgTable("startup_migrations", {
  id: text("id").primaryKey(),
  completedAt: timestamp("completed_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export default startupMigrationsTable;
