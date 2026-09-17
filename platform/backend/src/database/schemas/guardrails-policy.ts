import {
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import organizationsTable from "./organization";
import usersTable from "./user";

export const guardrailsPolicyRevisionsTable = pgTable(
  "guardrails_policy_revisions",
  {
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizationsTable.id, { onDelete: "cascade" }),
    revision: integer().notNull(),
    content: text().notNull(),
    contentHash: text("content_hash").notNull(),
    updatedBy: text("updated_by").references(() => usersTable.id, {
      onDelete: "set null",
    }),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.organizationId, table.revision] })],
);
