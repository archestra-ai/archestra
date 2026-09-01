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
import usersTable from "./user";

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
    /**
     * Who created this. Nullable: rows predating creator tracking have no
     * answer, and `ON DELETE SET NULL` gives the column back to "unknown" when
     * the account is deleted rather than taking the account with it — the
     * organization owns service accounts, not the person who happened to make it.
     */
    createdBy: text("created_by").references(() => usersTable.id, {
      onDelete: "set null",
    }),
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
