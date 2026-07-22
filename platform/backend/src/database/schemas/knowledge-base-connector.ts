import { DEFAULT_PERMISSION_SYNC_INTERVAL_SECONDS } from "@archestra/shared";
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import type {
  ConnectorCheckpoint,
  ConnectorConfig,
  ConnectorSyncStatus,
  ConnectorType,
  PermissionSyncState,
} from "@/types";
import type { KnowledgeSourceVisibility } from "@/types/knowledge-base";
import environmentsTable from "./environment";
import knowledgeBasesTable from "./knowledge-base";
import secretTable from "./secret";

const knowledgeBaseConnectorsTable = pgTable(
  "knowledge_base_connectors",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    visibility: text("visibility")
      .$type<KnowledgeSourceVisibility>()
      .notNull()
      .default("org-wide"),
    teamIds: jsonb("team_ids").$type<string[]>().notNull().default([]),
    connectorType: text("connector_type").$type<ConnectorType>().notNull(),
    config: jsonb("config").$type<ConnectorConfig>().notNull(),
    secretId: uuid("secret_id").references(() => secretTable.id, {
      onDelete: "set null",
    }),
    /**
     * Optional deployment Environment this connector belongs to. Null = the org
     * default environment. Referential only; the write path validates org
     * ownership. ON DELETE SET NULL falls the row back to the default.
     */
    environmentId: uuid("environment_id").references(
      () => environmentsTable.id,
      { onDelete: "set null" },
    ),
    schedule: text("schedule").notNull().default("0 */6 * * *"),
    /**
     * Cadence of the scheduled permission-sync pass for `auto-sync-permissions`
     * connectors: the next pass is due this many seconds after the last one
     * (manual, content-ingest-triggered, or scheduled) finished starting.
     * Ignored for other visibilities.
     */
    permissionSyncIntervalSeconds: integer("permission_sync_interval_seconds")
      .notNull()
      .default(DEFAULT_PERMISSION_SYNC_INTERVAL_SECONDS),
    enabled: boolean("enabled").notNull().default(true),
    lastSyncAt: timestamp("last_sync_at", { mode: "date" }),
    lastSyncStatus: text("last_sync_status").$type<ConnectorSyncStatus>(),
    lastSyncError: text("last_sync_error"),
    // Permission-sync status, kept separate from the content-sync fields above
    // so a permission run never clobbers `lastSyncAt` / `lastSyncStatus`.
    lastPermissionSyncAt: timestamp("last_permission_sync_at", {
      mode: "date",
    }),
    lastPermissionSyncStatus: text(
      "last_permission_sync_status",
    ).$type<ConnectorSyncStatus>(),
    checkpoint: jsonb("checkpoint").$type<ConnectorCheckpoint>(),
    /**
     * Opaque per-connector permission-sync probe state (audit-log cursors,
     * config fingerprints, last full-reconcile timestamp) read and written
     * only by the permission-sync delta machinery. NULL until the first pass.
     */
    permissionSyncState: jsonb(
      "permission_sync_state",
    ).$type<PermissionSyncState>(),
    // Monotonic fencing token bumped atomically whenever `visibility` or
    // `teamIds` change. Every ACL writer (content-sync ingest and the
    // permission-sync pass) fences its write on the value it read alongside the
    // visibility config, so a write computed against a now-stale config no-ops.
    aclConfigEpoch: bigint("acl_config_epoch", { mode: "number" })
      .notNull()
      .default(0),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "date" })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    index("knowledge_base_connectors_organization_id_idx").on(
      table.organizationId,
    ),
    index("knowledge_base_connectors_environment_id_idx").on(
      table.environmentId,
    ),
  ],
);

export default knowledgeBaseConnectorsTable;

/**
 * Junction table for many-to-many relationship between knowledge bases and connectors.
 * A connector can be assigned to multiple knowledge bases, and a knowledge base can
 * have multiple connectors feeding data into it.
 */
export const knowledgeBaseConnectorAssignmentsTable = pgTable(
  "knowledge_base_connector_assignment",
  {
    knowledgeBaseId: uuid("knowledge_base_id")
      .notNull()
      .references(() => knowledgeBasesTable.id, { onDelete: "cascade" }),
    connectorId: uuid("connector_id")
      .notNull()
      .references(() => knowledgeBaseConnectorsTable.id, {
        onDelete: "cascade",
      }),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    index("kb_connector_assignment_kb_id_idx").on(table.knowledgeBaseId),
    index("kb_connector_assignment_connector_id_idx").on(table.connectorId),
  ],
);
