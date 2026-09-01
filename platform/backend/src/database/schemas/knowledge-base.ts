import { sql } from "drizzle-orm";
import { index, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { softDeletablePgTable } from "./soft-deletable-table";
import usersTable from "./user";

const knowledgeBasesTable = softDeletablePgTable(
  "knowledge_bases",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    status: text("status").notNull().default("active"),
    /**
     * Who created this. Nullable: rows predating creator tracking have no
     * answer, and `ON DELETE SET NULL` gives the column back to "unknown" when
     * the account is deleted rather than taking the knowledge base with it — the
     * organization owns knowledge bases, not the person who happened to make it.
     */
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
    // Partial: every read of this table but the trash listing filters
    // `deleted_at IS NULL`, so the index only ever needs the active rows.
    // The trash's `status=deleted` slice scans instead — deliberately
    // unindexed, since soft-deleted rows are a small tail of a small table.
    index("knowledge_bases_organization_id_idx")
      .on(table.organizationId)
      .where(sql`deleted_at IS NULL`),
  ],
);

export default knowledgeBasesTable;
