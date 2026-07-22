import {
  boolean,
  index,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import type {
  InternalMcpCatalogServerType,
  LocalMcpServerInstallationStatus,
  McpServerReinstallReason,
  ResourceVisibilityScope,
} from "@/types";
import mcpCatalogTable from "./internal-mcp-catalog";
import secretTable from "./secret";
import { team } from "./team";
import usersTable from "./user";

// Terminal OAuth refresh error categories (transient failures persist nothing):
// - refresh_failed: the authorization server rejected the refresh grant
// - no_refresh_token: can't attempt recovery, no refresh token available
export const oauthRefreshErrorEnum = pgEnum("oauth_refresh_error_enum", [
  "refresh_failed",
  "no_refresh_token",
]);

const mcpServerTable = pgTable(
  "mcp_server",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    /**
     * Frozen K8s deployment name for local (non-multitenant) installs.
     * Written once at creation (`mcp-<slug40>-<id8>`); the startup adopt pass
     * backfills pre-existing rows from their live deployment's actual name.
     * Never updated on rename — deployment identity must not follow the
     * mutable display name, or renames orphan the running deployment.
     * NULL for remote installs and rows created before the column existed
     * that haven't been adopted yet.
     */
    deploymentName: text("deployment_name"),
    catalogId: uuid("catalog_id")
      .references(() => mcpCatalogTable.id, {
        onDelete: "set null",
      })
      .notNull(),
    serverType: text("server_type")
      .$type<InternalMcpCatalogServerType>()
      .notNull(),
    secretId: uuid("secret_id").references(() => secretTable.id, {
      onDelete: "set null",
    }),
    /**
     * Per-install plain (non-secret) env values for `promptOnInstallation`
     * env vars — supplied by the user in the install dialog and re-applied
     * by the runtime manager on every (re)deploy.
     *
     * Secret-typed prompted env values are not stored here; they live in
     * the per-install K8s Secret bundle referenced by `secretId`.
     *
     * Shape: `{ [envVarKey]: stringValue }`.
     */
    environmentValues: jsonb("environment_values")
      .$type<Record<string, string>>()
      .notNull()
      .default({}),
    ownerId: text("owner_id").references(() => usersTable.id, {
      onDelete: "set null",
    }),
    teamId: text("team_id").references(() => team.id, {
      onDelete: "set null",
    }),
    scope: text("scope")
      .$type<ResourceVisibilityScope>()
      .notNull()
      .default("personal"),
    reinstallRequired: boolean("reinstall_required").notNull().default(false),
    // Null iff `reinstallRequired` is false — enforced by McpServerModel.update.
    reinstallReason: text("reinstall_reason").$type<McpServerReinstallReason>(),
    localInstallationStatus: text("local_installation_status")
      .notNull()
      .default("idle")
      .$type<LocalMcpServerInstallationStatus>(),
    localInstallationError: text("local_installation_error"),
    oauthRefreshError: oauthRefreshErrorEnum("oauth_refresh_error"),
    // Sanitized OAuth `error` code from the failed grant (e.g. "invalid_grant").
    // Never holds token material, secrets, or URLs.
    oauthRefreshErrorMessage: text("oauth_refresh_error_message"),
    // Free-text OAuth `error_description` from the failed grant, shown in the
    // connection management UI. Passed through `sanitizeOAuthErrorDescription`
    // (services/oauth-refresh-classification.ts) before storage, which redacts
    // URLs, tokens, emails, and HTML — a blacklist, not a whitelist, so treat
    // this as lower-trust than `oauthRefreshErrorMessage` (whitelisted).
    // Returned by the API to the same audience that already sees
    // `oauthRefreshErrorMessage` — a deliberate choice, not an oversight.
    oauthRefreshErrorDescription: text("oauth_refresh_error_description"),
    oauthRefreshFailedAt: timestamp("oauth_refresh_failed_at", {
      mode: "date",
    }),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "date" })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [index("mcp_server_scope_idx").on(table.scope)],
);

export default mcpServerTable;
