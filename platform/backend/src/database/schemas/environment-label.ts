import { pgTable, primaryKey, timestamp, uuid } from "drizzle-orm/pg-core";
import environmentsTable from "./environment";
import labelKeyTable from "./label-key";
import labelValueTable from "./label-value";

/**
 * Key/value labels attached to environments.
 *
 * The primary key is (environmentId, key_id), so an environment carries at most one
 * value per key. Keys and values live in the shared `label_keys`/`label_values`
 * tables, so a label vocabulary is common across every labelled entity.
 */
const environmentLabelsTable = pgTable(
  "environment_labels",
  {
    environmentId: uuid("environment_id")
      .notNull()
      .references(() => environmentsTable.id, { onDelete: "cascade" }),
    keyId: uuid("key_id")
      .notNull()
      .references(() => labelKeyTable.id, { onDelete: "cascade" }),
    valueId: uuid("value_id")
      .notNull()
      .references(() => labelValueTable.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.environmentId, table.keyId] })],
);

export default environmentLabelsTable;
