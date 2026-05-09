import { sql } from "drizzle-orm";
import { pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { softDeleteColumns } from "./_soft-delete";
import organizationsTable from "./organization";

export const organizationRole = pgTable(
  "organization_role",
  {
    id: text("id").primaryKey(), // Better-auth uses base62 IDs, not UUIDs
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizationsTable.id, { onDelete: "cascade" }),
    role: text("role").notNull(), // Immutable identifier (lowercase, no spaces) - used by better-auth
    name: text("name").notNull(), // Editable display name - shown in UI
    description: text("description"),
    permission: text("permission").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").$onUpdate(
      () => /* @__PURE__ */ new Date(),
    ),
    ...softDeleteColumns,
  },
  (table) => [
    /**
     * Unique constraint ensures:
     * - One role per (organizationId, role) combination
     */
    uniqueIndex("organization_role_org_role_uidx")
      .on(table.organizationId, table.role)
      .where(sql`${table.deletedAt} IS NULL`),
  ],
);
