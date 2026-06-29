import {
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import conversationsTable from "./conversation";
import { team } from "./team";
import usersTable from "./user";

export const conversationShareVisibilityEnum = pgEnum(
  "conversation_share_visibility",
  ["organization", "team", "user"],
);

const conversationSharesTable = pgTable("conversation_shares", {
  id: uuid("id").primaryKey().defaultRandom(),
  conversationId: uuid("conversation_id")
    .notNull()
    .references(() => conversationsTable.id, { onDelete: "cascade" })
    .unique(),
  organizationId: text("organization_id").notNull(),
  createdByUserId: text("created_by_user_id").notNull(),
  visibility: conversationShareVisibilityEnum("visibility")
    .notNull()
    .default("organization"),
  createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
});

export const conversationShareTeamsTable = pgTable(
  "conversation_share_team",
  {
    shareId: uuid("share_id")
      .notNull()
      .references(() => conversationSharesTable.id, { onDelete: "cascade" }),
    teamId: text("team_id")
      .notNull()
      .references(() => team.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.shareId, table.teamId] }),
  }),
);

export const conversationShareUsersTable = pgTable(
  "conversation_share_user",
  {
    shareId: uuid("share_id")
      .notNull()
      .references(() => conversationSharesTable.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.shareId, table.userId] }),
  }),
);

export default conversationSharesTable;
