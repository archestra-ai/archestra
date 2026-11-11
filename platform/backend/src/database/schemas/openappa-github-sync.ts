import {
  boolean,
  integer,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import type { AppaSyncInterval } from "@/types/openappa-github-sync";
import organizationsTable from "./organization";

// One deployment-wide APPA source per organization. Accepted bytes survive disconnects.
// A row may exist without a source (null repo/path), left by an earlier declaration flag.
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
  // A GitLab access token in place of the GitHub App; its credential holds the host.
  gitlabTokenId: uuid("gitlab_token_id"),
  revision: uuid("revision").notNull().defaultRandom(),
  content: text("content"),
  sourceCommit: text("source_commit"),
  // Poll the initial policy PR before importing anything from the template branch.
  setupPullRequestNumber: integer("setup_pull_request_number"),
  // Whether each MCP server's editors change its own rules through pull
  // requests: the policy check, the branch ruleset and the registry action.
  // ARCHESTRA_OPENAPPA_SELF_SERVICE, while set, wins over it.
  selfService: boolean("self_service").notNull().default(false),
  // The folder beside the policy file that holds one rules file per MCP
  // server, which `<folder>/*.toml` in the policy includes.
  selfServiceDirectory: text("self_service_directory").notNull().default("mcp"),
  lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
  lastSyncError: text("last_sync_error"),
});
