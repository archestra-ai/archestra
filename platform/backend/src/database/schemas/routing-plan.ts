import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type {
  RouterDocument,
  RoutingPlanStatus,
  RoutingPlanTrigger,
} from "@/types/auto-routing";
import organizationsTable from "./organization";
import routingScorerVersionsTable from "./routing-scorer-version";

/** Every fit outcome per organization; at most one `active` plan serves traffic. */
const routingPlansTable = pgTable(
  "routing_plans",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizationsTable.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    trigger: text("trigger").$type<RoutingPlanTrigger>().notNull(),
    /** Settings generation the fit read. */
    generation: bigint("generation", { mode: "number" }).notNull(),
    /** Fit start time; usage idle relative to it was the fit's input. */
    inputWatermark: timestamp("input_watermark", {
      withTimezone: true,
    }).notNull(),
    tiersFingerprint: jsonb("tiers_fingerprint")
      .$type<RouterDocument>()
      .notNull(),
    budgetUsdPerDay: numeric("budget_usd_per_day", {
      precision: 12,
      scale: 2,
    }).notNull(),
    scorerVersionId: uuid("scorer_version_id")
      .notNull()
      .references(() => routingScorerVersionsTable.id),
    coreVersion: text("core_version").notNull(),
    planFormatVersion: integer("plan_format_version").notNull(),
    plan: jsonb("plan").$type<RouterDocument>(),
    summary: jsonb("summary").$type<RouterDocument>(),
    diagnostics: jsonb("diagnostics").$type<RouterDocument>(),
    status: text("status").$type<RoutingPlanStatus>().notNull(),
    error: text("error"),
  },
  (table) => [
    uniqueIndex("routing_plans_one_active_per_org_uidx")
      .on(table.organizationId)
      .where(sql`${table.status} = 'active'`),
    index("routing_plans_org_created_at_idx").on(
      table.organizationId,
      table.createdAt,
    ),
    check(
      "routing_plans_status_check",
      sql`${table.status} IN ('active', 'superseded', 'failed', 'cold_start', 'rejected')`,
    ),
    check(
      "routing_plans_trigger_check",
      sql`${table.trigger} IN ('initial', 'nightly', 'settings', 'manual', 'scorer_change', 'backfill')`,
    ),
    check(
      "routing_plans_plan_check",
      sql`(${table.plan} IS NOT NULL) = (${table.status} IN ('active', 'superseded'))`,
    ),
    check(
      "routing_plans_error_check",
      sql`${table.status} NOT IN ('failed', 'rejected') OR ${table.error} IS NOT NULL`,
    ),
  ],
);

export default routingPlansTable;
