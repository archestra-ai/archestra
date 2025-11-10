import type { Permissions } from "@shared";
import {
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import organizationsTable from "./organization";

export const organizationRole = pgTable(
  "organization_role",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizationsTable.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    permission: jsonb("permission").$type<Permissions>().notNull(),
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
