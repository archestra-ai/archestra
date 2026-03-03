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
  ConnectorType,
} from "@/types";
import knowledgeBasesTable from "./knowledge-base";
import secretTable from "./secret";

const knowledgeBaseConnectorsTable = pgTable(
  "knowledge_base_connectors",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id").notNull(),
    knowledgeBaseId: uuid("knowledge_base_id")
      .notNull()
      .references(() => knowledgeBasesTable.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    connectorType: text("connector_type").$type<ConnectorType>().notNull(),
    config: jsonb("config").$type<ConnectorConfig>().notNull(),
    secretId: uuid("secret_id").references(() => secretTable.id, {
      onDelete: "set null",
    }),
    schedule: text("schedule").notNull().default("0 */6 * * *"),
    enabled: boolean("enabled").notNull().default(true),
    lastSyncAt: timestamp("last_sync_at", { mode: "date" }),
    lastSyncStatus: text("last_sync_status"),
    lastSyncError: text("last_sync_error"),
    checkpoint: jsonb("checkpoint").$type<ConnectorCheckpoint>(),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "date" })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    index("knowledge_base_connectors_knowledge_base_id_idx").on(
      table.knowledgeBaseId,
    ),
    index("knowledge_base_connectors_organization_id_idx").on(
      table.organizationId,
    ),
  ],
);

export default knowledgeBaseConnectorsTable;
