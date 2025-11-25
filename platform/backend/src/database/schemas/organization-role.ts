import { pgTable, text, timestamp, unique } from "drizzle-orm/pg-core";
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
    permission: text("permission").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").$onUpdate(
      () => /* @__PURE__ */ new Date(),
    ),
  },
  (table) => [
    /**
     * Unique constraint ensures:
     * - One role per (organizationId, role) combination
     */
    unique().on(table.organizationId, table.role),
  ],
);
