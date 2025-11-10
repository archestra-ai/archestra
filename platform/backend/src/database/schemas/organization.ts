import type { OrganizationCustomFont, OrganizationTheme } from "@shared";
import { pgTable, text, timestamp, varchar } from "drizzle-orm/pg-core";
import type { OrganizationLimitCleanupInterval } from "@/types";

const organizationsTable = pgTable("organization", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  logo: text("logo"),
  createdAt: timestamp("created_at").notNull(),
  metadata: text("metadata"),
  limitCleanupInterval: varchar("limit_cleanup_interval")
    .$type<OrganizationLimitCleanupInterval>()
    .default("1h"),
  theme: text("theme")
    .$type<OrganizationTheme>()
    .notNull()
    .default("cosmic-night"),
  customFont: text("custom_font")
    .$type<OrganizationCustomFont>()
    .notNull()
    .default("lato"),
});

export default organizationsTable;
