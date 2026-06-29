import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import type { ConnectorSyncStatus } from "@/types/knowledge-connector";
import knowledgeBaseConnectorsTable from "./knowledge-base-connector";

const connectorRunsTable = pgTable(
  "connector_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    connectorId: uuid("connector_id")
      .notNull()
      .references(() => knowledgeBaseConnectorsTable.id, {
        onDelete: "cascade",
      }),
    status: text("status").$type<ConnectorSyncStatus>().notNull(),
    startedAt: timestamp("started_at", { mode: "date" }).notNull(),
    completedAt: timestamp("completed_at", { mode: "date" }),
    documentsProcessed: integer("documents_processed").default(0),
    documentsIngested: integer("documents_ingested").default(0),
    totalItems: integer("total_items"),
    totalBatches: integer("total_batches").default(0),
    completedBatches: integer("completed_batches").default(0),
    itemErrors: integer("item_errors").default(0),
    itemsSkipped: integer("items_skipped").default(0),
    error: text("error"),
    logs: text("logs"),
    checkpoint: jsonb("checkpoint").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  },
  (table) => [index("connector_runs_connector_id_idx").on(table.connectorId)],
);

export default connectorRunsTable;
