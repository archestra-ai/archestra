import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import type {
  BatchAnalysisRowSource,
  BatchAnalysisRowSourceType,
} from "@/types/batch-analysis";
import batchAnalysesTable from "./batch-analysis";

/**
 * One row of the grid — a single input the columns are evaluated against.
 *
 * The source is stored as a discriminated `{ sourceType, source }` pair rather
 * than a foreign key to any particular table, so a row can point at a knowledge
 * base document today and something else later without a migration. `sourceType`
 * is denormalized out of the JSONB purely so it can be indexed and filtered.
 */
const batchAnalysisRowsTable = pgTable(
  "batch_analysis_rows",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    analysisId: uuid("analysis_id")
      .notNull()
      .references(() => batchAnalysesTable.id, { onDelete: "cascade" }),
    /** Human-readable label for the row (document title, record name, ...). */
    label: text("label").notNull(),
    sourceType: text("source_type")
      .$type<BatchAnalysisRowSourceType>()
      .notNull(),
    source: jsonb("source").$type<BatchAnalysisRowSource>().notNull(),
    sortIndex: integer("sort_index").notNull().default(0),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    index("batch_analysis_rows_analysis_id_idx").on(
      table.analysisId,
      table.sortIndex,
    ),
  ],
);

export default batchAnalysisRowsTable;
