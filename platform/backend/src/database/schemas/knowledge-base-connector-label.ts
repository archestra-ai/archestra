import { pgTable, primaryKey, timestamp, uuid } from "drizzle-orm/pg-core";
import knowledgeBaseConnectorsTable from "./knowledge-base-connector";
import labelKeyTable from "./label-key";
import labelValueTable from "./label-value";

/**
 * Key/value labels attached to knowledge connectors.
 *
 * The primary key is (connectorId, key_id), so a knowledge connector carries at most one
 * value per key. Keys and values live in the shared `label_keys`/`label_values`
 * tables, so a label vocabulary is common across every labelled entity.
 */
const knowledgeBaseConnectorLabelsTable = pgTable(
  "knowledge_base_connector_labels",
  {
    connectorId: uuid("connector_id")
      .notNull()
      .references(() => knowledgeBaseConnectorsTable.id, {
        onDelete: "cascade",
      }),
    keyId: uuid("key_id")
      .notNull()
      .references(() => labelKeyTable.id, { onDelete: "cascade" }),
    valueId: uuid("value_id")
      .notNull()
      .references(() => labelValueTable.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.connectorId, table.keyId] })],
);

export default knowledgeBaseConnectorLabelsTable;
