import { sql } from "drizzle-orm";
import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import type { LimitCleanupInterval } from "@/types";
import environmentsTable from "./environment";
import organizationsTable from "./organization";

/**
 * Default token-cost limit applied per organization member, optionally scoped to
 * a single environment. This is the unified store for default user limits:
 *
 *   - environment_id IS NULL  → the organization-wide default (applies to every
 *     environment that has no specific row, and to requests with no environment).
 *   - environment_id = <env>  → a per-environment default that overrides the
 *     org-wide default for requests in that environment.
 *
 * Enforcement precedence (see LimitValidationService.checkDefaultUserLimit):
 * a custom per-user `limits` row wins; otherwise the per-environment row for the
 * request's environment applies; otherwise the org-wide (NULL) row applies.
 *
 * Usage is computed per user from interactions; for a per-environment row it is
 * scoped to interactions snapshotted to that environment
 * (interactions.environment_id). This is the per-user cap — distinct from an
 * environment-scoped row in the `limits` table, which caps total (all-user)
 * usage in the environment.
 *
 * NOTE: the table name retains the `environment_` prefix for migration safety
 * (renaming an applied table is avoided); NULL environment_id is the org-wide
 * default.
 */
const environmentDefaultUserLimitsTable = pgTable(
  "environment_default_user_limits",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizationsTable.id, { onDelete: "cascade" }),
    // Nullable: NULL = the organization-wide default.
    environmentId: uuid("environment_id").references(
      () => environmentsTable.id,
      { onDelete: "cascade" },
    ),
    /** Token-cost limit value in dollars. */
    limitValue: integer("limit_value").notNull(),
    /** Models covered by the limit. Null means all models. */
    model: jsonb("model").$type<string[] | null>(),
    cleanupInterval: varchar("cleanup_interval")
      .$type<LimitCleanupInterval>()
      .notNull()
      .default("calendar_month"),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "date" })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    // One default per environment (NULLs are excluded from this constraint).
    unique("environment_default_user_limits_environment_unique").on(
      table.environmentId,
    ),
    // Exactly one org-wide (NULL-environment) default per organization. A
    // partial unique index is required because SQL UNIQUE treats NULLs as
    // distinct, so it would otherwise allow many NULL-environment rows.
    uniqueIndex("environment_default_user_limits_org_global_unique")
      .on(table.organizationId)
      .where(sql`${table.environmentId} IS NULL`),
    index("environment_default_user_limits_org_idx").on(table.organizationId),
  ],
);

export default environmentDefaultUserLimitsTable;
