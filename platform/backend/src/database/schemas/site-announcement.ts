import {
  index,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import organizationsTable from "./organization";
import usersTable from "./user";

const siteAnnouncementsTable = pgTable(
  "site_announcement",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizationsTable.id, { onDelete: "cascade" }),
    markdown: text("markdown").notNull(),
    expiresAt: timestamp("expires_at", { mode: "date" }),
    createdByUserId: text("created_by_user_id").references(
      () => usersTable.id,
      {
        onDelete: "set null",
      },
    ),
    updatedByUserId: text("updated_by_user_id").references(
      () => usersTable.id,
      {
        onDelete: "set null",
      },
    ),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    unique("site_announcement_organization_unique").on(table.organizationId),
    index("site_announcement_org_idx").on(table.organizationId),
  ],
);

export default siteAnnouncementsTable;
