import {
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { team } from "./team";
import usersTable from "./user";

/**
 * A project: a named collection of chat conversations with a dedicated result
 * folder (`folders.project_id`). The folder is created together with the
 * project and shares its name — project names are validated with the
 * folder-name rules for exactly that reason.
 *
 * Sharing (below) grants project access: browse chats, start your own, and
 * full rights over the result folder's files (list/download/delete) — the
 * folder belongs to the project, not to any one member.
 */
const projectsTable = pgTable(
  "projects",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    /** Folder-name-validated; immutable in v1 (it names the result folder). */
    name: text("name").notNull(),
    description: text("description"),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    // one project name per user.
    uniqueIndex("projects_user_name_uidx").on(table.userId, table.name),
  ],
);

export const projectShareVisibilityEnum = pgEnum("project_share_visibility", [
  "organization",
  "team",
]);

/** One share row per project; mirrors `conversation_shares`. */
export const projectSharesTable = pgTable("project_shares", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id")
    .notNull()
    .references(() => projectsTable.id, { onDelete: "cascade" })
    .unique(),
  organizationId: text("organization_id").notNull(),
  createdByUserId: text("created_by_user_id").notNull(),
  visibility: projectShareVisibilityEnum("visibility")
    .notNull()
    .default("organization"),
  createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
});

export const projectShareTeamsTable = pgTable(
  "project_share_team",
  {
    shareId: uuid("share_id")
      .notNull()
      .references(() => projectSharesTable.id, { onDelete: "cascade" }),
    teamId: text("team_id")
      .notNull()
      .references(() => team.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.shareId, table.teamId] }),
  }),
);

export default projectsTable;
