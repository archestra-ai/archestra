import {
  type AnyPgColumn,
  boolean,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import type { TeamMemberRole } from "@/types/team-role";
import organizationsTable from "./organization";
import usersTable from "./user";

export const team = pgTable(
  "team",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    description: text("description"),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizationsTable.id, { onDelete: "cascade" }),
    parentId: text("parent_team_id").references((): AnyPgColumn => team.id, {
      onDelete: "set null",
    }),
    createdBy: text("created_by")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at").notNull(),
    updatedAt: timestamp("updated_at")
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
    convertToolResultsToToon: boolean("convert_tool_results_to_toon")
      .notNull()
      .default(false),
  },
  (table) => [index("team_parent_team_id_idx").on(table.parentId)],
);

export const teamMember = pgTable(
  "team_member",
  {
    id: text("id").primaryKey(),
    teamId: text("team_id")
      .notNull()
      .references(() => team.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    role: text("role").$type<TeamMemberRole>().default("member").notNull(),
    /**
     * Indicates this membership was created via SSO team sync.
     * Synced members are automatically managed during SSO login.
     * Members without this flag were added manually and won't be removed by sync.
     */
    syncedFromSso: boolean("synced_from_sso").notNull().default(false),
    createdAt: timestamp("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("team_member_team_id_user_id_unique_idx").on(
      table.teamId,
      table.userId,
    ),
    index("team_member_team_id_user_id_idx").on(table.teamId, table.userId),
    index("team_member_user_id_team_id_idx").on(table.userId, table.teamId),
  ],
);
