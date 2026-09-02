import { pgTable, primaryKey, timestamp, uuid } from "drizzle-orm/pg-core";
import kbFilesTable from "./kb-file";
import labelKeyTable from "./label-key";
import labelValueTable from "./label-value";

/**
 * Key/value labels attached to knowledge files.
 *
 * The primary key is (fileId, key_id), so a knowledge file carries at most one
 * value per key. Keys and values live in the shared `label_keys`/`label_values`
 * tables, so a label vocabulary is common across every labelled entity.
 */
const kbFileLabelsTable = pgTable(
  "kb_file_labels",
  {
    fileId: uuid("file_id")
      .notNull()
      .references(() => kbFilesTable.id, { onDelete: "cascade" }),
    keyId: uuid("key_id")
      .notNull()
      .references(() => labelKeyTable.id, { onDelete: "cascade" }),
    valueId: uuid("value_id")
      .notNull()
      .references(() => labelValueTable.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.fileId, table.keyId] })],
);

export default kbFileLabelsTable;
