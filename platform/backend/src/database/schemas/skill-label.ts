import { pgTable, primaryKey, timestamp, uuid } from "drizzle-orm/pg-core";
import labelKeyTable from "./label-key";
import labelValueTable from "./label-value";
import skillsTable from "./skill";

/**
 * Key/value labels attached to skills.
 *
 * The primary key is (skillId, key_id), so a skill carries at most one
 * value per key. Keys and values live in the shared `label_keys`/`label_values`
 * tables, so a label vocabulary is common across every labelled entity.
 */
const skillLabelsTable = pgTable(
  "skill_labels",
  {
    skillId: uuid("skill_id")
      .notNull()
      .references(() => skillsTable.id, { onDelete: "cascade" }),
    keyId: uuid("key_id")
      .notNull()
      .references(() => labelKeyTable.id, { onDelete: "cascade" }),
    valueId: uuid("value_id")
      .notNull()
      .references(() => labelValueTable.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.skillId, table.keyId] })],
);

export default skillLabelsTable;
