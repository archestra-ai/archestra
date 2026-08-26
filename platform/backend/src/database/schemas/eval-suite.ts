import { sql } from "drizzle-orm";
import { index, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { softDeletablePgTable } from "./soft-deletable-table";
import usersTable from "./user";

/**
 * Eval suites: named, org-scoped collections of eval cases that can be run
 * against an agent to grade its behavior. Soft-deletable so run history under
 * a deleted suite stays resolvable.
 */
const evalSuitesTable = softDeletablePgTable(
  "eval_suites",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    /** User who created the suite; nulled if the user is removed. */
    createdBy: text("created_by").references(() => usersTable.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "date" })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    index("eval_suites_organization_id_idx").on(table.organizationId),
    // Soft-deleted rows are excluded so deleting a suite frees its name.
    uniqueIndex("eval_suites_org_name_idx")
      .on(table.organizationId, table.name)
      .where(sql`${table.deletedAt} IS NULL`),
  ],
);

export default evalSuitesTable;
