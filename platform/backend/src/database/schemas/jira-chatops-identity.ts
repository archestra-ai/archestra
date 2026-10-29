import {
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import usersTable from "./user";

/** Observed human identities remain pinned even after Jira hides their email. */
const jiraChatOpsIdentitiesTable = pgTable(
  "jira_chatops_identities",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    integrationId: uuid("integration_id").notNull(),
    organizationId: text("organization_id").notNull(),
    accountId: varchar("account_id", { length: 256 }).notNull(),
    // Retain a tombstone when a user is deleted, so a known human cannot become
    // the service fallback merely because their original Archestra user is gone.
    userId: text("user_id").references(() => usersTable.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("jira_chatops_identities_account_idx").on(
      table.integrationId,
      table.accountId,
    ),
  ],
);

export default jiraChatOpsIdentitiesTable;
