import { pgTable, primaryKey, timestamp, uuid } from "drizzle-orm/pg-core";
import knowledgeBasesTable from "./knowledge-base";
import labelKeyTable from "./label-key";
import labelValueTable from "./label-value";

/**
 * Key/value labels attached to knowledge bases.
 *
 * The primary key is (knowledgeBaseId, key_id), so a knowledge base carries at most one
 * value per key. Keys and values live in the shared `label_keys`/`label_values`
 * tables, so a label vocabulary is common across every labelled entity.
 */
const knowledgeBaseLabelsTable = pgTable(
  "knowledge_base_labels",
  {
    knowledgeBaseId: uuid("knowledge_base_id")
      .notNull()
      .references(() => knowledgeBasesTable.id, { onDelete: "cascade" }),
    keyId: uuid("key_id")
      .notNull()
      .references(() => labelKeyTable.id, { onDelete: "cascade" }),
    valueId: uuid("value_id")
      .notNull()
      .references(() => labelValueTable.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.knowledgeBaseId, table.keyId] })],
);

export default knowledgeBaseLabelsTable;
