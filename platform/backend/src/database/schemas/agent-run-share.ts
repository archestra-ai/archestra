import {
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import a2aTasksTable from "./a2a-task";
import { team } from "./team";
import usersTable from "./user";

export const agentRunShareVisibilityEnum = pgEnum(
  "agent_run_share_visibility",
  ["organization", "team", "user"],
);

const agentRunSharesTable = pgTable("agent_run_shares", {
  id: uuid("id").primaryKey().defaultRandom(),
  taskId: uuid("task_id")
    .notNull()
    .references(() => a2aTasksTable.id, { onDelete: "cascade" })
    .unique(),
  organizationId: text("organization_id").notNull(),
  createdByUserId: text("created_by_user_id").notNull(),
  visibility: agentRunShareVisibilityEnum("visibility")
    .notNull()
    .default("organization"),
  createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
});

export const agentRunShareTeamsTable = pgTable(
  "agent_run_share_team",
  {
    shareId: uuid("share_id")
      .notNull()
      .references(() => agentRunSharesTable.id, { onDelete: "cascade" }),
    teamId: text("team_id")
      .notNull()
      .references(() => team.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.shareId, table.teamId] }),
  }),
);

export const agentRunShareUsersTable = pgTable(
  "agent_run_share_user",
  {
    shareId: uuid("share_id")
      .notNull()
      .references(() => agentRunSharesTable.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.shareId, table.userId] }),
  }),
);

export default agentRunSharesTable;
