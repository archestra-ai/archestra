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
import knowledgeGraphsTable from "./knowledge-graph";
import secretTable from "./secret";

const knowledgeGraphConnectorsTable = pgTable(
  "knowledge_graph_connectors",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id").notNull(),
    knowledgeGraphId: uuid("knowledge_graph_id")
      .notNull()
      .references(() => knowledgeGraphsTable.id, { onDelete: "cascade" }),
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
    index("knowledge_graph_connectors_knowledge_graph_id_idx").on(
      table.knowledgeGraphId,
    ),
    index("knowledge_graph_connectors_organization_id_idx").on(
      table.organizationId,
    ),
  ],
);

export default knowledgeGraphConnectorsTable;
