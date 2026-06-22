import type { McpUiResourcePermissions } from "@modelcontextprotocol/ext-apps";
import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type { AppSpec } from "@/types/app-spec";
import appsTable from "./app";

/**
 * Append-only immutable snapshot of an app's runtime artifact. Every edit that
 * changes the canonical payload (html + permissions) forks a new version
 * (`version` increments per app from 1); an edit producing an identical payload
 * reuses the latest version. `apps.latest_version` points at the head.
 *
 * The permissions are snapshotted alongside the HTML so a pinned version is a
 * fully self-contained, immutable artifact — serving an old version reproduces
 * the exact security envelope it was authored with. The CSP is not part of the
 * artifact: the serve path always pins the platform CSP (see APP_PLATFORM_CSP).
 *
 * `app_id` is nullable and `ON DELETE SET NULL` so version bytes survive the
 * source app's deletion, mirroring `skill_versions`.
 */
const appVersionsTable = pgTable(
  "app_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    appId: uuid("app_id").references(() => appsTable.id, {
      onDelete: "set null",
    }),
    /** Per-app version number, starting at 1. */
    version: integer("version").notNull(),
    /** Immutable app HTML captured at fork time. */
    html: text("html").notNull(),
    /** Sandbox permissions this version requests (null → none). */
    uiPermissions: jsonb("ui_permissions").$type<McpUiResourcePermissions>(),
    /** sha256 of the canonical payload (html + permissions); suppresses no-op forks. */
    contentHash: text("content_hash").notNull(),
    /**
     * Snapshot of the app's spec when this html was forked (null for legacy or
     * spec-less forks). Provenance only — not part of `contentHash`.
     */
    spec: jsonb("spec").$type<AppSpec>(),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    index("app_versions_app_id_idx").on(table.appId),
    uniqueIndex("app_versions_app_version_uidx").on(table.appId, table.version),
  ],
);

export default appVersionsTable;
