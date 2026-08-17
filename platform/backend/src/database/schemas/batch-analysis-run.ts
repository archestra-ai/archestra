import { sql } from "drizzle-orm";
import {
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type { BatchAnalysisRunStatus } from "@/types/batch-analysis";
import batchAnalysesTable from "./batch-analysis";

/**
 * One execution of an analysis. Progress counters are advanced atomically by the
 * per-row workers; the last row to finish flips the run terminal, mirroring how
 * `batch_embedding` finalizes a connector run.
 */
const batchAnalysisRunsTable = pgTable(
  "batch_analysis_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    analysisId: uuid("analysis_id")
      .notNull()
      .references(() => batchAnalysesTable.id, { onDelete: "cascade" }),
    organizationId: text("organization_id").notNull(),
    status: text("status").$type<BatchAnalysisRunStatus>().notNull(),
    /** Rows this run dispatched work for — the finalization denominator. */
    totalRows: integer("total_rows").notNull().default(0),
    completedRows: integer("completed_rows").notNull().default(0),
    /** Cell-level counters, for progress display only. */
    totalCells: integer("total_cells").notNull().default(0),
    doneCells: integer("done_cells").notNull().default(0),
    erroredCells: integer("errored_cells").notNull().default(0),
    error: text("error"),
    startedAt: timestamp("started_at", { mode: "date" }).notNull(),
    completedAt: timestamp("completed_at", { mode: "date" }),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    index("batch_analysis_runs_analysis_id_idx").on(table.analysisId),
    // Single-flight per analysis: a second run cannot start while one is live,
    // so two workers can never contend for the same cell.
    uniqueIndex("batch_analysis_runs_one_running_per_analysis_idx")
      .on(table.analysisId)
      .where(sql`status = 'running'`),
  ],
);

export default batchAnalysisRunsTable;
