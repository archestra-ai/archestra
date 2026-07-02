import { index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import projectsTable from "./project";
import usersTable from "./user";

/**
 * One memory entry of a project: a short durable fact/preference the assistant
 * saved for the project ("the launch is July 15"). Entries are injected into
 * the system prompt of every chat in the project and are managed by the
 * save/list/update/delete memory tools and the project Memory panel.
 *
 * Deleted with the project (FK cascade). Content length and the per-project
 * entry count are app-enforced ({@link ProjectMemoryModel}) against the shared
 * PROJECT_MEMORY_* caps.
 */
const projectMemoriesTable = pgTable(
  "project_memories",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projectsTable.id, { onDelete: "cascade" }),
    organizationId: text("organization_id").notNull(),
    /** Author attribution; kept (as null) when the user is deleted. */
    createdByUserId: text("created_by_user_id").references(
      () => usersTable.id,
      { onDelete: "set null" },
    ),
    content: text("content").notNull(),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    index("project_memories_project_idx").on(table.projectId),
  ],
);

export default projectMemoriesTable;
