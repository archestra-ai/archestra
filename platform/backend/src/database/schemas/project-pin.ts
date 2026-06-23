import {
  index,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import projectsTable from "./project";
import usersTable from "./user";

/**
 * A user's personal pin on a project. Pinning is per-user — a shared project
 * pinned by one member is not pinned for others — so it lives in this join
 * table rather than as a column on `projects`. `pinned_at` is both the marker
 * and the sort key for the sidebar "Pinned" section.
 */
const projectPinsTable = pgTable(
  "project_pins",
  {
    userId: text("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projectsTable.id, { onDelete: "cascade" }),
    pinnedAt: timestamp("pinned_at", { mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.projectId] }),
    // backs the FK cascade delete from `projects` (mirrors files_project_id_idx)
    index("project_pins_project_id_idx").on(table.projectId),
  ],
);

export default projectPinsTable;
