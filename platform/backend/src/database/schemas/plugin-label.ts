import { pgTable, primaryKey, timestamp, uuid } from "drizzle-orm/pg-core";
import labelKeyTable from "./label-key";
import labelValueTable from "./label-value";
import pluginsTable from "./plugin";

/**
 * Key/value labels attached to plugins.
 *
 * The primary key is (pluginId, key_id), so a plugin carries at most one
 * value per key. Keys and values live in the shared `label_keys`/`label_values`
 * tables, so a label vocabulary is common across every labelled entity.
 */
const pluginLabelsTable = pgTable(
  "plugin_labels",
  {
    pluginId: uuid("plugin_id")
      .notNull()
      .references(() => pluginsTable.id, { onDelete: "cascade" }),
    keyId: uuid("key_id")
      .notNull()
      .references(() => labelKeyTable.id, { onDelete: "cascade" }),
    valueId: uuid("value_id")
      .notNull()
      .references(() => labelValueTable.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.pluginId, table.keyId] })],
);

export default pluginLabelsTable;
