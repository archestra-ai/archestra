import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import knowledgeGraphConnectorsTable from "./knowledge-graph-connector";

const connectorRunsTable = pgTable(
  "connector_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    connectorId: uuid("connector_id")
      .notNull()
      .references(() => knowledgeGraphConnectorsTable.id, {
        onDelete: "cascade",
      }),
    status: text("status").notNull(),
    startedAt: timestamp("started_at", { mode: "date" }).notNull(),
    completedAt: timestamp("completed_at", { mode: "date" }),
    documentsProcessed: integer("documents_processed").default(0),
    documentsIngested: integer("documents_ingested").default(0),
    error: text("error"),
    checkpoint: jsonb("checkpoint").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  },
  (table) => [index("connector_runs_connector_id_idx").on(table.connectorId)],
);

export default connectorRunsTable;
