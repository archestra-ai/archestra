import { sql } from "drizzle-orm";
import {
  index,
  integer,
  jsonb,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type { AppSpec } from "@/types/app-spec";
import type { ResourceVisibilityScope } from "@/types/visibility";
import environmentsTable from "./environment";
import { softDeletablePgTable } from "./soft-deletable-table";
import usersTable from "./user";

/**
 * User-authored MCP Apps: interactive apps created inside Archestra (from chat
 * or the /apps page). An app belongs to an organization and carries a
 * visibility `scope` (`personal`/`team`/`org`) like agents and skills.
 *
 * The app row holds catalog metadata only. Its HTML (plus the CSP/permissions
 * it ships with) lives in immutable `app_versions` snapshots; `latestVersion`
 * points at the head. Team assignments live in `app_team`, tool attachments in
 * `app_tool`, and the per-app data store in `app_data`.
 */
const appsTable = softDeletablePgTable(
  "apps",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id").notNull(),
    /** User who created the app; nulled if the user is removed. */
    authorId: text("author_id").references(() => usersTable.id, {
      onDelete: "set null",
    }),
    /**
     * Visibility/management scope: `personal` (author only), `team` (members of
     * the assigned teams, see `app_team`), or `org` (everyone). Mirrors the
     * `agents.scope` model. Chat-created apps default to `personal`.
     */
    scope: text("scope")
      .$type<ResourceVisibilityScope>()
      .notNull()
      .default("personal"),
    /** Display name surfaced in the apps list and the model's app tools. */
    name: text("name").notNull(),
    /** Optional one-line summary the model uses when listing apps. */
    description: text("description"),
    /** Id of the starter template the app was created from, for provenance. */
    templateId: text("template_id"),
    /**
     * Optional Environment the app is bound to. The bound environment confines
     * which MCP tools the app may be assigned and may call at runtime to that
     * environment (matched on the tool's catalog environment). Null = the org
     * default environment. ON DELETE SET NULL re-binds the app to the default
     * rather than orphaning it.
     *
     * The FK is referential only; it does NOT encode org ownership, so the write
     * path that sets `apps.environment_id` validates the environment belongs to
     * the app's organization (via `assertCanAssignEnvironment`) to prevent
     * cross-tenant binding.
     */
    environmentId: uuid("environment_id").references(
      () => environmentsTable.id,
      { onDelete: "set null" },
    ),
    /**
     * Consolidated requirements the app was refined to (mutable head; re-refining
     * overwrites it). Null for legacy apps authored before the refine flow.
     */
    spec: jsonb("spec").$type<AppSpec>(),
    /**
     * Head version number, pointing at the latest `app_versions` row. Bumped in
     * the same transaction as an edit that forks a new version. Every app has at
     * least version 1 (written on create).
     */
    latestVersion: integer("latest_version").notNull(),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "date" })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    index("apps_organization_id_idx").on(table.organizationId),
    index("apps_scope_idx").on(table.scope),
    index("apps_environment_id_idx").on(table.environmentId),
    // Name uniqueness mirrors visibility (like skills): personal apps are unique
    // per (org, author), shared apps per org. Soft-deleted rows are excluded so
    // deleting an app frees its name for re-use.
    uniqueIndex("apps_org_personal_name_idx")
      .on(table.organizationId, table.authorId, table.name)
      .where(sql`${table.scope} = 'personal' AND ${table.deletedAt} IS NULL`),
    uniqueIndex("apps_org_shared_name_idx")
      .on(table.organizationId, table.name)
      .where(
        sql`${table.scope} in ('team', 'org') AND ${table.deletedAt} IS NULL`,
      ),
  ],
);

export default appsTable;
