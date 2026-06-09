import {
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type { ProjectScope } from "@/types/project";
import usersTable from "./user";

const projectsTable = pgTable(
  "projects",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id").notNull(),
    authorId: text("author_id").references(() => usersTable.id, {
      onDelete: "set null",
    }),
    scope: text("scope").$type<ProjectScope>().notNull().default("personal"),
    name: text("name").notNull(),
    description: text("description"),
    icon: text("icon"),
    instructions: text("instructions"),
    archivedAt: timestamp("archived_at", { mode: "date" }),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "date" })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    index("projects_organization_id_idx").on(table.organizationId),
    index("projects_author_id_idx").on(table.authorId),
    index("projects_scope_idx").on(table.scope),
    uniqueIndex("projects_personal_name_idx").on(
      table.organizationId,
      table.authorId,
      table.name,
    ),
  ],
);

export default projectsTable;
