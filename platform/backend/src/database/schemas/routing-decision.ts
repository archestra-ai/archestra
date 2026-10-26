import { sql } from "drizzle-orm";
import {
  check,
  doublePrecision,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type {
  RoutingDecisionReason,
  RoutingSessionFeatures,
} from "@/types/auto-routing";
import modelsTable from "./model";
import organizationsTable from "./organization";
import routingScorerVersionsTable from "./routing-scorer-version";

/** One sticky auto-routing decision per session (segment 0 until mid-session switching exists). */
const routingDecisionsTable = pgTable(
  "routing_decisions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizationsTable.id, { onDelete: "cascade" }),
    sessionKey: text("session_key").notNull(),
    segment: integer("segment").notNull().default(0),
    tierIndex: smallint("tier_index").notNull(),
    modelId: uuid("model_id")
      .notNull()
      .references(() => modelsTable.id, { onDelete: "cascade" }),
    propensity: doublePrecision("propensity").notNull(),
    u: doublePrecision("u").notNull(),
    /** Provenance only, not a foreign key. Null exactly for cold_start and plan_stale. */
    planId: uuid("plan_id"),
    reason: text("reason").$type<RoutingDecisionReason>().notNull(),
    scorerVersionId: uuid("scorer_version_id").references(
      () => routingScorerVersionsTable.id,
    ),
    features: jsonb("features").$type<RoutingSessionFeatures>(),
    scorerCost: numeric("scorer_cost", { precision: 13, scale: 10 }),
    featuresSchemaVersion: integer("features_schema_version").notNull(),
    coreVersion: text("core_version").notNull(),
    planFormatVersion: integer("plan_format_version"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("routing_decisions_org_session_segment_uidx").on(
      table.organizationId,
      table.sessionKey,
      table.segment,
    ),
    index("routing_decisions_created_at_idx").on(table.createdAt),
    check(
      "routing_decisions_reason_check",
      sql`${table.reason} IN ('planned', 'cold_start', 'scorer_error', 'plan_stale')`,
    ),
    check(
      "routing_decisions_plan_id_check",
      sql`(${table.planId} IS NULL) = (${table.reason} IN ('cold_start', 'plan_stale'))`,
    ),
    check(
      "routing_decisions_scorer_error_features_check",
      sql`${table.reason} <> 'scorer_error' OR ${table.features} IS NULL`,
    ),
  ],
);

export default routingDecisionsTable;
