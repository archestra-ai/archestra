import { sql } from "drizzle-orm";
import {
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { softDeleteColumns } from "./_soft-delete";

const labelValueTable = pgTable(
  "label_values",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    value: text("value").notNull(),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "date" })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
    ...softDeleteColumns,
  },
  (table) => [
    uniqueIndex("label_values_value_uidx")
      .on(table.value)
      .where(sql`${table.deletedAt} IS NULL`),
  ],
);

export default labelValueTable;
