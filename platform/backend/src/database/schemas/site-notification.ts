import { boolean, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import organizationsTable from "./organization";

const siteNotificationsTable = pgTable("site_notification", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id")
    .notNull()
    .references(() => organizationsTable.id, { onDelete: "cascade" }),
  content: text("content").notNull(),
  expiresAt: timestamp("expires_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
  isActive: boolean("is_active").notNull().default(true),
});

export default siteNotificationsTable;
