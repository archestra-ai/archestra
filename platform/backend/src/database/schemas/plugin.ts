import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type {
  ClientType,
  PluginGithubSyncInterval,
  PluginPlatform,
  PluginSourceKind,
} from "@/types/plugin";
import type { ResourceVisibilityScope } from "@/types/visibility";
import githubAppConfigsTable from "./github-app-config";
import githubPatsTable from "./github-pat";
import { softDeletablePgTable } from "./soft-deletable-table";
import usersTable from "./user";

const pluginsTable = softDeletablePgTable(
  "plugins",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id").notNull(),
    authorId: text("author_id").references(() => usersTable.id, {
      onDelete: "set null",
    }),
    scope: text("scope")
      .$type<ResourceVisibilityScope>()
      .notNull()
      .default("org"),
    clientType: text("client_type").$type<ClientType>().notNull(),
    supportedPlatforms: text("supported_platforms")
      .array()
      .$type<PluginPlatform[]>()
      .notNull()
      .default(["posix"]),
    /** Installed plugin identity. Frozen after insert. */
    pluginSlug: text("plugin_slug").notNull(),
    displayName: text("display_name").notNull(),
    description: text("description").notNull().default(""),
    contentHash: text("content_hash").notNull(),
    sourceKind: text("source_kind")
      .$type<PluginSourceKind>()
      .notNull()
      .default("manual"),
    sourceRepo: text("source_repo"),
    sourceRef: text("source_ref"),
    sourceSha: text("source_sha"),
    sourceSubdir: text("source_subdir"),
    sourceExclude: text("source_exclude").array().notNull().default([]),
    sourceMarketplaceRepo: text("source_marketplace_repo"),
    sourceMarketplacePath: text("source_marketplace_path"),
    sourceMarketplacePluginName: text("source_marketplace_plugin_name"),
    githubSyncInterval: text(
      "github_sync_interval",
    ).$type<PluginGithubSyncInterval>(),
    githubSyncRef: text("github_sync_ref"),
    githubAppConfigId: uuid("github_app_config_id").references(
      () => githubAppConfigsTable.id,
      { onDelete: "restrict" },
    ),
    githubPatId: uuid("github_pat_id").references(() => githubPatsTable.id, {
      onDelete: "restrict",
    }),
    lastSyncedAt: timestamp("last_synced_at", { mode: "date" }),
    lastSyncError: text("last_sync_error"),
    pendingSourceSha: text("pending_source_sha"),
    pendingContentHash: text("pending_content_hash"),
    pendingDetectedAt: timestamp("pending_detected_at", { mode: "date" }),
    syncGeneration: integer("sync_generation").notNull().default(0),
    /** Stable identity for a plugin shipped by Archestra itself. */
    sourceId: text("source_id"),
    approvedContentHash: text("approved_content_hash"),
    approvedAt: timestamp("approved_at", { mode: "date" }),
    approvedBy: text("approved_by").references(() => usersTable.id, {
      onDelete: "set null",
    }),
    enabled: boolean("enabled").notNull().default(true),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "date" })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    index("plugins_organization_id_idx").on(table.organizationId),
    index("plugins_scope_idx").on(table.scope),
    index("plugins_github_sync_due_idx")
      .on(table.lastSyncedAt)
      .where(sql`${table.githubSyncInterval} IS NOT NULL`),
    index("plugins_org_client_type_idx").on(
      table.organizationId,
      table.clientType,
    ),
    uniqueIndex("plugins_org_plugin_slug_uidx")
      .on(table.organizationId, table.pluginSlug)
      .where(sql`${table.deletedAt} IS NULL`),
    uniqueIndex("plugins_source_id_uidx")
      .on(table.organizationId, table.sourceId)
      .where(sql`${table.sourceId} IS NOT NULL AND ${table.deletedAt} IS NULL`),
    uniqueIndex("plugins_org_marketplace_entry_uidx")
      .on(
        table.organizationId,
        sql`lower(${table.sourceMarketplaceRepo})`,
        table.sourceMarketplacePath,
        sql`lower(${table.sourceMarketplacePluginName})`,
      )
      .where(
        sql`${table.sourceMarketplaceRepo} IS NOT NULL AND ${table.sourceMarketplacePath} IS NOT NULL AND ${table.sourceMarketplacePluginName} IS NOT NULL AND ${table.deletedAt} IS NULL`,
      ),
  ],
);

export default pluginsTable;
