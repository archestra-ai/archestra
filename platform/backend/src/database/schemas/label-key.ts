import { pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

const labelKeyTable = pgTable("label_keys", {
  id: uuid("id").primaryKey().defaultRandom(),
  key: text("key").notNull().unique(),
  createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { mode: "date" })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export default labelKeyTable;
