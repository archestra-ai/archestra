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
 * A project: a named collection of chat conversations that owns its result
 * files directly (`files.project_id`, cascade on delete). Files belong to the
 * project, not to any one member.
 *
 * Sharing (below) grants project access: browse chats, start your own, and
 * full rights over the project's files (list/download/delete).
 */
const projectsTable = pgTable(
  "projects",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    /** Validated display name; immutable in v1. */
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
