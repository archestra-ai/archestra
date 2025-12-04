import { boolean, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import organizationsTable from "./organization";
import usersTable from "./user";

export const team = pgTable("team", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description"),
  organizationId: text("organization_id")
    .notNull()
    .references(() => organizationsTable.id, { onDelete: "cascade" }),
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
});

export const teamMember = pgTable("team_member", {
  id: text("id").primaryKey(),
  teamId: text("team_id")
    .notNull()
    .references(() => team.id, { onDelete: "cascade" }),
  userId: text("user_id")
    .notNull()
    .references(() => usersTable.id, { onDelete: "cascade" }),
  role: text("role").default("member").notNull(),
  /**
   * Indicates this membership was created via SSO team sync.
   * Synced members are automatically managed during SSO login.
   * Members without this flag were added manually and won't be removed by sync.
   */
  syncedFromSso: boolean("synced_from_sso").notNull().default(false),
  createdAt: timestamp("created_at").notNull(),
});
