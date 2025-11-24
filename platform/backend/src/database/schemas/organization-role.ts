import { pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import organizationsTable from "./organization";

export const organizationRole = pgTable(
  "organization_role",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizationsTable.id, { onDelete: "cascade" }),
    name: text("name").notNull(), // Immutable identifier (lowercase, no spaces) - used by better-auth
    title: text("title").notNull(), // Editable display name - shown in UI
    permission: text("permission").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").$onUpdate(
      () => /* @__PURE__ */ new Date(),
    ),
  },
  (table) => [
    /**
     * Unique constraint ensures:
     * - One role per (organizationId, name) combination
     */
    unique().on(table.organizationId, table.name),
  ],
);
