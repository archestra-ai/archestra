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
    // Liveness lease: the owning worker renews `leaseExpiresAt` (a heartbeat)
    // across both the ingest and embedding-drain phases. A run whose lease has
    // lapsed is treated as orphaned by the reaper. `leaseEpoch` is a monotonic
    // fencing token bumped on every (re)claim so a paused-then-revived owner's
    // guarded writes match no row. See connector-run.ts for the claim/renew SQL.
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: timestamp("lease_expires_at", { mode: "date" }),
    leaseEpoch: bigint("lease_epoch", { mode: "number" }).notNull().default(0),
    heartbeatAt: timestamp("heartbeat_at", { mode: "date" }),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    index("connector_runs_connector_id_idx").on(table.connectorId),
    // Single-flight: at most one active (running) run per connector. A second
    // concurrent sync's INSERT fails cleanly instead of racing to supersede.
    uniqueIndex("connector_runs_one_running_per_connector_idx")
      .on(table.connectorId)
      .where(sql`status = 'running'`),
    // Reaper scan: find running runs whose lease has expired.
    index("connector_runs_lease_expires_at_idx")
      .on(table.leaseExpiresAt)
      .where(sql`status = 'running'`),
  ],
);

export default connectorRunsTable;
