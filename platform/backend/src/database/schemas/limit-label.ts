import { pgTable, primaryKey, timestamp, uuid } from "drizzle-orm/pg-core";
import labelKeyTable from "./label-key";
import labelValueTable from "./label-value";
import limitsTable from "./limit";

/**
 * Key/value labels attached to limits.
 *
 * The primary key is (limitId, key_id), so a limit carries at most one
 * value per key. Keys and values live in the shared `label_keys`/`label_values`
 * tables, so a label vocabulary is common across every labelled entity.
 */
const limitLabelsTable = pgTable(
  "limit_labels",
  {
    limitId: uuid("limit_id")
      .notNull()
      .references(() => limitsTable.id, { onDelete: "cascade" }),
    keyId: uuid("key_id")
      .notNull()
      .references(() => labelKeyTable.id, { onDelete: "cascade" }),
    valueId: uuid("value_id")
      .notNull()
      .references(() => labelValueTable.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.limitId, table.keyId] })],
);

export default limitLabelsTable;
