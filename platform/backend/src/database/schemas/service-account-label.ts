import { pgTable, primaryKey, timestamp, uuid } from "drizzle-orm/pg-core";
import labelKeyTable from "./label-key";
import labelValueTable from "./label-value";
import serviceAccountsTable from "./service-account";

/**
 * Key/value labels attached to service accounts.
 *
 * The primary key is (serviceAccountId, key_id), so a service account carries at most one
 * value per key. Keys and values live in the shared `label_keys`/`label_values`
 * tables, so a label vocabulary is common across every labelled entity.
 */
const serviceAccountLabelsTable = pgTable(
  "service_account_labels",
  {
    serviceAccountId: uuid("service_account_id")
      .notNull()
      .references(() => serviceAccountsTable.id, { onDelete: "cascade" }),
    keyId: uuid("key_id")
      .notNull()
      .references(() => labelKeyTable.id, { onDelete: "cascade" }),
    valueId: uuid("value_id")
      .notNull()
      .references(() => labelValueTable.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.serviceAccountId, table.keyId] })],
);

export default serviceAccountLabelsTable;
