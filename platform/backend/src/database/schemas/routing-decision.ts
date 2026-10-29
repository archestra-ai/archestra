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
  RoutingDecisionFeatures,
  RoutingDecisionReason,
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
    features: jsonb("features").$type<RoutingDecisionFeatures>(),
    scorerCost: numeric("scorer_cost", { precision: 13, scale: 10 }),
    featuresSchemaVersion: integer("features_schema_version").notNull(),
    coreVersion: text("core_version").notNull(),
    planFormatVersion: integer("plan_format_version"),
    /** The λ the session was routed with; null unless planned. */
    lambda: doublePrecision("lambda"),
    /** The chosen tier's predicted session cost in USD, as the solver counts it; null unless planned. */
    expectedCostUsd: numeric("expected_cost_usd", { precision: 16, scale: 10 }),
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
    index("routing_decisions_org_plan_idx").on(
      table.organizationId,
      table.planId,
    ),
    // Deleting a model deletes its decisions through the foreign key; without
    // this each deleted model reads the whole table.
    index("routing_decisions_model_id_idx").on(table.modelId),
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
