import { sql } from "drizzle-orm";
import { index, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { softDeletablePgTable } from "./soft-deletable-table";

const knowledgeBasesTable = softDeletablePgTable(
  "knowledge_bases",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    status: text("status").notNull().default("active"),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "date" })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    // Partial: every read of this table filters `deleted_at IS NULL`, so the
    // index only ever needs the active rows — soft-deleted ones stay out of it
    // rather than growing an index nothing scans.
    index("knowledge_bases_organization_id_idx")
      .on(table.organizationId)
      .where(sql`deleted_at IS NULL`),
  ],
);

export default knowledgeBasesTable;
