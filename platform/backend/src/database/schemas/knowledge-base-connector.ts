import {
  boolean,
  index,
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
} from "@/types";
import knowledgeBasesTable from "./knowledge-base";
import secretTable from "./secret";

const knowledgeBaseConnectorsTable = pgTable(
  "knowledge_base_connectors",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    connectorType: text("connector_type").$type<ConnectorType>().notNull(),
    config: jsonb("config").$type<ConnectorConfig>().notNull(),
    secretId: uuid("secret_id").references(() => secretTable.id, {
      onDelete: "set null",
    }),
    schedule: text("schedule").notNull().default("0 */6 * * *"),
    enabled: boolean("enabled").notNull().default(true),
    lastSyncAt: timestamp("last_sync_at", { mode: "date" }),
    lastSyncStatus: text("last_sync_status").$type<ConnectorSyncStatus>(),
    lastSyncError: text("last_sync_error"),
    checkpoint: jsonb("checkpoint").$type<ConnectorCheckpoint>(),
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
