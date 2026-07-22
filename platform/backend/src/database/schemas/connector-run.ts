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
import type { PermissionSyncRunStats } from "@/types/knowledge-base-connector";
import type {
  ConnectorRunType,
  ConnectorSyncStatus,
} from "@/types/knowledge-connector";
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
    // Which runtime-isolated job family this run belongs to. `content` is the
    // existing ingestion sync; `permission` is the permission-sync pass. The
    // two single-flight independently (see the composite index below).
    runType: text("run_type")
      .$type<ConnectorRunType>()
      .notNull()
      .default("content"),
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
    // Per-run outcome stats. Written by the permission-sync pass (see
    // PermissionSyncRunStats) so its runs surface family-relevant counters
    // (docs scanned, ACLs changed, fail-closed, groups) instead of the
    // content-sync document counters, which stay 0 for permission runs.
    stats: jsonb("stats").$type<PermissionSyncRunStats>(),
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
    // Single-flight per (connector, run type): at most one active (running) run
    // of each family per connector. A content run and a permission run for the
    // same connector can be `running` simultaneously; a second run of the same
    // family INSERTs cleanly-failed instead of racing to supersede.
    uniqueIndex("connector_runs_one_running_per_connector_run_type_idx")
      .on(table.connectorId, table.runType)
      .where(sql`status = 'running'`),
    // Reaper scan: find running runs whose lease has expired.
    index("connector_runs_lease_expires_at_idx")
      .on(table.leaseExpiresAt)
      .where(sql`status = 'running'`),
  ],
);

export default connectorRunsTable;
