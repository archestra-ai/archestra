import { jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import usersTable from "./user";

/**
 * A user's saved browser login state (Playwright storageState: cookies and
 * localStorage), restored into every new browser context the user gets so
 * logins survive new conversations and Playwright pod restarts.
 *
 * Shared across all of the user's agents. The value holds live session
 * credentials, so it is stored encrypted and never returned to clients.
 */
const browserStorageStatesTable = pgTable("browser_storage_states", {
  userId: text("user_id")
    .primaryKey()
    .references(() => usersTable.id, { onDelete: "cascade" }),
  encryptedState: jsonb("encrypted_state")
    .$type<{ __encrypted: string }>()
    .notNull(),
  updatedAt: timestamp("updated_at", { mode: "date" })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export default browserStorageStatesTable;
