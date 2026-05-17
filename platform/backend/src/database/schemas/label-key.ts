import { pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

const labelKeyTable = pgTable("label_keys", {
  id: uuid("id").primaryKey().defaultRandom(),
  key: text("key").notNull().unique(),
  deletedAt: timestamp("deleted_at", { mode: "date" }),`n  createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { mode: "date" })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export default labelKeyTable;
