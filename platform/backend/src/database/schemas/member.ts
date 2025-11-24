import { MEMBER_ROLE_NAME } from "@shared";
import { pgTable, text, timestamp } from "drizzle-orm/pg-core";
import organizationsTable from "./organization";
import usersTable from "./user";

const member = pgTable("member", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id")
    .notNull()
    .references(() => organizationsTable.id, { onDelete: "cascade" }),
  userId: text("user_id")
    .notNull()
    .references(() => usersTable.id, { onDelete: "cascade" }),
  // Built-in role name or custom role name.
  // It's a name not an id / reference because better-auth references the roles by names.
  role: text("role").default(MEMBER_ROLE_NAME),
  createdAt: timestamp("created_at").notNull(),
});

export default member;
