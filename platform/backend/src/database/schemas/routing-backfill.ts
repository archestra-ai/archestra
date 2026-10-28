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
  RoutingBackfillBreakdown,
  RoutingBackfillPhase,
  RoutingBackfillStatus,
} from "@/types/auto-routing";
import organizationsTable from "./organization";
import routingScorerVersionsTable from "./routing-scorer-version";
import usersTable from "./user";

/**
 * One historical backfill of an organization's auto-routing history: a free
 * scan of past interactions in [window_start, cutoff), then, once an admin
 * starts it, scoring of a deterministic sample with the scorer version under
 * a USD ceiling. The lease (owner + epoch) fences every write a worker makes.
 */
const routingBackfillsTable = pgTable(
  "routing_backfills",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizationsTable.id, { onDelete: "cascade" }),
    status: text("status").$type<RoutingBackfillStatus>().notNull(),
    phase: text("phase").$type<RoutingBackfillPhase>().notNull(),
    cutoff: timestamp("cutoff", { withTimezone: true }).notNull(),
    windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
    /** Set when the scan finished: its sessions are complete from then on. */
    scannedAt: timestamp("scanned_at", { withTimezone: true }),
    scorerVersionId: uuid("scorer_version_id").references(
      () => routingScorerVersionsTable.id,
    ),
    maxSessions: integer("max_sessions"),
    maxCostUsd: numeric("max_cost_usd", { precision: 10, scale: 4 }),
    reservedCostUsd: numeric("reserved_cost_usd", { precision: 12, scale: 6 })
      .notNull()
      .default("0"),
    spentCostUsd: numeric("spent_cost_usd", { precision: 12, scale: 6 })
      .notNull()
      .default("0"),
    /** Highest cost one scorer call settled at; later calls reserve at least this. */
    callCostUsd: numeric("call_cost_usd", { precision: 12, scale: 6 })
      .notNull()
      .default("0"),
    attempts: integer("attempts").notNull().default(0),
    populationSessions: integer("population_sessions").notNull().default(0),
    populationTokens: bigint("population_tokens", { mode: "number" })
      .notNull()
      .default(0),
    breakdown: jsonb("breakdown")
      .$type<RoutingBackfillBreakdown>()
      .notNull()
      .default([]),
    // Scan cursor: the last interaction read, as `created_at::text` (exact to
    // the microsecond) plus its profile and id.
    cursorProfileId: uuid("cursor_profile_id"),
    cursorCreatedAt: text("cursor_created_at"),
    cursorId: uuid("cursor_id"),
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    leaseEpoch: bigint("lease_epoch", { mode: "number" }).notNull().default(0),
    consecutiveFailures: integer("consecutive_failures").notNull().default(0),
    error: text("error"),
    /** The settings generation its completion raised, so readers can wait for that fit. */
    fitGeneration: bigint("fit_generation", { mode: "number" }),
    startedBy: text("started_by").references(() => usersTable.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("routing_backfills_one_active_per_org_uidx")
      .on(table.organizationId)
      .where(sql`${table.status} IN ('running', 'scanned')`),
    index("routing_backfills_org_created_at_idx").on(
      table.organizationId,
      table.createdAt,
    ),
    check(
      "routing_backfills_status_check",
      sql`${table.status} IN ('running', 'scanned', 'done', 'failed', 'cancelled', 'superseded')`,
    ),
    check(
      "routing_backfills_phase_check",
      sql`${table.phase} IN ('scan', 'score')`,
    ),
    check(
      "routing_backfills_score_check",
      sql`${table.phase} = 'scan' OR (${table.scorerVersionId} IS NOT NULL AND ${table.maxSessions} IS NOT NULL AND ${table.maxCostUsd} IS NOT NULL AND ${table.scannedAt} IS NOT NULL)`,
    ),
  ],
);

export default routingBackfillsTable;
