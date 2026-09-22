import {
  boolean,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import type {
  AppaSyncInterval,
  HeldPullReason,
} from "@/types/openappa-github-sync";
import organizationsTable from "./organization";

// One deployment-wide APPA source per organization. Accepted bytes survive disconnects.
// A row may exist without a source (null repo/path) to carry the declaration flags alone.
export const openappaGithubSyncTable = pgTable("openappa_github_sync", {
  organizationId: text("organization_id")
    .primaryKey()
    .references(() => organizationsTable.id, { onDelete: "cascade" }),
  repo: text("repo"),
  ref: text("ref"),
  path: text("path"),
  interval: text("interval").$type<AppaSyncInterval>(),
  githubPatId: uuid("github_pat_id"),
  githubAppConfigId: uuid("github_app_config_id"),
  revision: uuid("revision").notNull().defaultRandom(),
  content: text("content"),
  sourceCommit: text("source_commit"),
  lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
  lastSyncError: text("last_sync_error"),
  // The migration window: the declarations this deployment authored are not in the repository yet.
  declarationsPendingPublish: boolean("declarations_pending_publish")
    .notNull()
    .default(false),
  // A pull that was fetched but not published, awaiting an operator with the right permissions.
  heldContent: text("held_content"),
  heldContentHash: text("held_content_hash"),
  heldSourceCommit: text("held_source_commit"),
  heldReasons: jsonb("held_reasons")
    .$type<HeldPullReason[]>()
    .notNull()
    .default([]),
});
