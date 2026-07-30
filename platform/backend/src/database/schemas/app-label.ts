import { pgTable, primaryKey, timestamp, uuid } from "drizzle-orm/pg-core";
import appsTable from "./app";
import labelKeyTable from "./label-key";
import labelValueTable from "./label-value";

const appLabelsTable = pgTable(
  "app_labels",
  {
    appId: uuid("app_id")
      .notNull()
      .references(() => appsTable.id, { onDelete: "cascade" }),
    keyId: uuid("key_id")
      .notNull()
      .references(() => labelKeyTable.id, { onDelete: "cascade" }),
    valueId: uuid("value_id")
      .notNull()
      .references(() => labelValueTable.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.appId, table.keyId] })],
);

export default appLabelsTable;
