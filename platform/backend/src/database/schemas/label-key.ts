import { sql } from "drizzle-orm";
import {
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { softDeleteColumns } from "./_soft-delete";

const labelKeyTable = pgTable(
  "label_keys",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    key: text("key").notNull(),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "date" })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
    ...softDeleteColumns,
  },
  (table) => [
    uniqueIndex("label_keys_key_uidx")
      .on(table.key)
      .where(sql`${table.deletedAt} IS NULL`),
  ],
);

export default labelKeyTable;
