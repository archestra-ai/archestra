import {
  index,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import appsTable from "./app";
import projectsTable from "./project";
import usersTable from "./user";

/**
 * An app linked into a project. The link is a pointer, not ownership: the app
 * keeps its own permissions, and a project member sees a linked app only when
 * they can read the app itself. Deleting either side drops the link.
 */
const projectAppsTable = pgTable(
  "project_apps",
  {
    projectId: uuid("project_id")
      .notNull()
      .references(() => projectsTable.id, { onDelete: "cascade" }),
    appId: uuid("app_id")
      .notNull()
      .references(() => appsTable.id, { onDelete: "cascade" }),
    /** Who linked it; kept when that user is removed. */
    linkedBy: text("linked_by").references(() => usersTable.id, {
      onDelete: "set null",
    }),
    linkedAt: timestamp("linked_at", { mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.projectId, table.appId] }),
    // backs the FK cascade delete from `apps`
    index("project_apps_app_id_idx").on(table.appId),
  ],
);

export default projectAppsTable;
