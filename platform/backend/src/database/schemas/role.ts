import { pgTable, text, timestamp, unique } from "drizzle-orm/pg-core";
import organizationsTable from "./organization";

export const role = pgTable(
  "role",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizationsTable.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description"),
    permissions: text("permissions").array().notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at")
      .notNull()
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date()),
  },
  (table) => [
    unique().on(table.organizationId, table.name),
  ],
);

export default role;
