import type { OrganizationCustomFont, OrganizationTheme } from "@shared";
import {
  boolean,
  pgTable,
  text,
  timestamp,
  varchar,
} from "drizzle-orm/pg-core";
import type {
  OrganizationCompressionScope,
  OrganizationLimitCleanupInterval,
} from "@/types";

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
  onboardingComplete: boolean("onboarding_complete").notNull().default(false),
  theme: text("theme")
    .$type<OrganizationTheme>()
    .notNull()
    .default("cosmic-night"),
  customFont: text("custom_font")
    .$type<OrganizationCustomFont>()
    .notNull()
    .default("lato"),
  convertToolResultsToToon: boolean("convert_tool_results_to_toon")
    .notNull()
    .default(true),
  compressionScope: varchar("compression_scope")
    .$type<OrganizationCompressionScope>()
    .notNull()
    .default("organization"),
  autoConfigureNewTools: boolean("auto_configure_new_tools")
    .notNull()
    .default(false),
});

export default organizationsTable;
