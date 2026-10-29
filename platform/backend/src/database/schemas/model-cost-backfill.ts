import { sql } from "drizzle-orm";
import {
  bigint,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type {
  ModelCostBackfillPhase,
  ModelCostBackfillPricing,
  ModelCostBackfillStatus,
} from "@/types/model-cost-backfill";
import modelsTable from "./model";
import organizationsTable from "./organization";
import usersTable from "./user";

/**
 * One recompute of a model's recorded interaction costs, from `since` up to
 * `cutoff` (when it was started), with prices frozen at start. The cursor
 * makes it resumable across worker restarts; the lease (owner + epoch) makes
 * sure only one worker writes for it at a time.
 */
const modelCostBackfillsTable = pgTable(
  "model_cost_backfills",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizationsTable.id, { onDelete: "cascade" }),
    modelId: uuid("model_id")
      .notNull()
      .references(() => modelsTable.id, { onDelete: "cascade" }),
    since: timestamp("since", { mode: "date" }).notNull(),
    cutoff: timestamp("cutoff", { mode: "date" }).notNull(),
    pricing: jsonb("pricing").$type<ModelCostBackfillPricing>().notNull(),
    status: text("status")
      .$type<ModelCostBackfillStatus>()
      .notNull()
      .default("pending"),
    phase: text("phase")
      .$type<ModelCostBackfillPhase>()
      .notNull()
      .default("main"),
    // Last row written, as `created_at::text` (microsecond-exact; a JS Date
    // drops microseconds and would re-read or skip rows) plus its id.
    cursorCreatedAt: text("cursor_created_at"),
    cursorId: uuid("cursor_id"),
    // Eligible rows visited and rows whose stored cost actually changed.
    rowsScanned: integer("rows_scanned").notNull().default(0),
    rowsUpdated: integer("rows_updated").notNull().default(0),
    // Eligible rows when the backfill started, for progress.
    rowsEstimated: integer("rows_estimated").notNull(),
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: timestamp("lease_expires_at", { mode: "date" }),
    // Bumped on every claim; a worker whose epoch no longer matches has been
    // superseded and its writes match no row.
    leaseEpoch: bigint("lease_epoch", { mode: "number" }).notNull().default(0),
    consecutiveFailures: integer("consecutive_failures").notNull().default(0),
    error: text("error"),
    createdByUserId: text("created_by_user_id").references(
      () => usersTable.id,
      {
        onDelete: "set null",
      },
    ),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "date" })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
    completedAt: timestamp("completed_at", { mode: "date" }),
  },
  (table) => [
    // One active backfill per model: a second start is refused, not queued.
    uniqueIndex("model_cost_backfills_active_model_idx")
      .on(table.modelId)
      .where(sql`${table.status} in ('pending', 'running')`),
    index("model_cost_backfills_model_created_at_idx").on(
      table.modelId,
      table.createdAt,
    ),
  ],
);

export default modelCostBackfillsTable;
