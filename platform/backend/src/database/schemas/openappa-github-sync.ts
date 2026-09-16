import { pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import type { AppaSyncInterval } from "@/types/openappa-github-sync";
import organizationsTable from "./organization";

// One deployment-wide APPA source per organization. Accepted bytes survive disconnects.
export const openappaGithubSyncTable = pgTable("openappa_github_sync", {
  organizationId: text("organization_id")
    .primaryKey()
    .references(() => organizationsTable.id, { onDelete: "cascade" }),
  repo: text("repo").notNull(),
  ref: text("ref"),
  path: text("path").notNull(),
  interval: text("interval").$type<AppaSyncInterval>(),
  githubPatId: uuid("github_pat_id"),
  githubAppConfigId: uuid("github_app_config_id"),
  revision: uuid("revision").notNull().defaultRandom(),
  content: text("content"),
  sourceCommit: text("source_commit"),
  lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
  lastSyncError: text("last_sync_error"),
});
