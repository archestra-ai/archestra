import { boolean, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import type { OrganizationAppearance } from "@/types/organization";

const organizationsTable = pgTable("organization", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  logo: text("logo"),
  createdAt: timestamp("created_at").notNull(),
  metadata: text("metadata"),
  hasSeededMcpCatalog: boolean("has_seeded_mcp_catalog")
    .default(false)
    .notNull(),
  theme: text("theme")
    .$type<OrganizationAppearance["theme"]>()
    .default("cosmic-night"),
  customFont: text("custom_font")
    .$type<OrganizationAppearance["customFont"]>()
    .default("lato"),
  logoType: text("logo_type")
    .$type<OrganizationAppearance["logoType"]>()
    .default("default"),
});

export default organizationsTable;
