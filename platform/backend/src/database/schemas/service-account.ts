import {
  boolean,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import organizationsTable from "./organization";

const serviceAccountsTable = pgTable(
  "service_accounts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizationsTable.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    role: text("role").notNull(),
    disabled: boolean("disabled").notNull().default(false),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "date" })
      .notNull()
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date()),
  },
  (table) => [
    index("service_accounts_organization_id_idx").on(table.organizationId),
    uniqueIndex("service_accounts_organization_id_name_unique_idx").on(
      table.organizationId,
      table.name,
    ),
  ],
);

export default serviceAccountsTable;
