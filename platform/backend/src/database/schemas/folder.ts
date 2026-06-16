import { sql } from "drizzle-orm";
import {
  check,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import projectsTable from "./project";
import usersTable from "./user";

/**
 * A PFS folder, owned by EITHER a user (personal folder) OR a project (its
 * result folder) — never both, never neither (the owner check below).
 *
 *   - Personal folder: `user_id` set, `project_id` null. The owner has full
 *     rights; names are unique per user.
 *   - Project folder: `project_id` set, `user_id` null. Anyone with access to
 *     the project has full rights over its files; one folder per project.
 *
 * Files reference folders via `files.folder_id` (SET NULL on delete).
 */
const foldersTable = pgTable(
  "folders",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id").notNull(),
    /** Personal owner; null for project folders (owner check below). */
    userId: text("user_id").references(() => usersTable.id, {
      onDelete: "cascade",
    }),
    /** Owning project; null for personal folders. One result folder per project. */
    projectId: uuid("project_id").references(() => projectsTable.id, {
      onDelete: "cascade",
    }),
    /** Validated display name. */
    name: text("name").notNull(),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    // one folder name per user — personal folders only (project folders are
    // identified by their project, and a project's name is already unique).
    uniqueIndex("folders_user_name_uidx")
      .on(table.userId, table.name)
      .where(sql`${table.userId} IS NOT NULL`),
    // one result folder per project.
    uniqueIndex("folders_project_uidx")
      .on(table.projectId)
      .where(sql`${table.projectId} IS NOT NULL`),
    // a folder is owned by exactly one of: a user, a project.
    check(
      "folders_owner_chk",
      sql`((${table.userId} IS NOT NULL)::int + (${table.projectId} IS NOT NULL)::int) = 1`,
    ),
  ],
);

export default foldersTable;
