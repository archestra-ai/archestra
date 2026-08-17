import {
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type {
  BatchAnalysisCellStatus,
  BatchAnalysisCitation,
} from "@/types/batch-analysis";
import batchAnalysisRowsTable from "./batch-analysis-row";

/**
 * One `(row, column)` intersection.
 *
 * `status` is the load-bearing column of the whole feature: a resumed run skips
 * cells already `done`, and an individual cell can be reset to `pending` and
 * re-dispatched without touching its neighbours. It makes this a job table that
 * happens to be shaped like a spreadsheet.
 */
const batchAnalysisCellsTable = pgTable(
  "batch_analysis_cells",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    rowId: uuid("row_id")
      .notNull()
      .references(() => batchAnalysisRowsTable.id, { onDelete: "cascade" }),
    /** References `batch_analyses.columns[].key`. */
    columnKey: text("column_key").notNull(),
    status: text("status")
      .$type<BatchAnalysisCellStatus>()
      .notNull()
      .default("pending"),
    content: text("content"),
    citations: jsonb("citations").$type<BatchAnalysisCitation[]>(),
    error: text("error"),
    updatedAt: timestamp("updated_at", { mode: "date" })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    // One cell per (row, column). Also the upsert conflict target, which is what
    // makes cell creation idempotent across re-runs.
    uniqueIndex("batch_analysis_cells_row_column_idx").on(
      table.rowId,
      table.columnKey,
    ),
    index("batch_analysis_cells_status_idx").on(table.rowId, table.status),
  ],
);

export default batchAnalysisCellsTable;
