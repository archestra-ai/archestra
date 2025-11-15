import { jsonb, pgTable, timestamp, uuid } from "drizzle-orm/pg-core";
import type { SecretValue } from "@/types";

const secretTable = pgTable("secret", {
  id: uuid("id").primaryKey().defaultRandom(),
  secret: jsonb("secret").$type<SecretValue>().notNull().default({}),
  createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { mode: "date" })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export default secretTable;
