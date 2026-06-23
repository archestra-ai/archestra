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
    /** Validated display name; editable by the owner (unique per user). */
    name: text("name").notNull(),
    /**
     * Immutable URL-safe identifier derived from the name at creation, unique
     * per org. Addresses the project's folder in the filesystem file store, so
     * renaming the display name never moves files on disk.
     */
    slug: text("slug").notNull(),
    description: text("description"),
    /** Emoji character or base64-encoded image data URL, like agents/catalog. */
    icon: text("icon"),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    // display name stays unique per user: one member can't have two same-named
    // projects, but different members may reuse a name (their slugs differ).
    uniqueIndex("projects_user_name_uidx").on(table.userId, table.name),
    // the slug is the project's folder in the filesystem file store, so it must
    // be unique across the org's members.
    uniqueIndex("projects_org_slug_uidx").on(table.organizationId, table.slug),
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
