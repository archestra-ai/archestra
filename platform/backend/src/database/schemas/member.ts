import { MEMBER_ROLE_NAME } from "@shared";
import { pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import agentsTable from "./agent";
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
  // Role identifier e.g. "member" (buit-in) or "reader" (custom)
  // It's because better-auth references the roles by identifiers not uuids.
  role: text("role").default(MEMBER_ROLE_NAME).notNull(),
  createdAt: timestamp("created_at").notNull(),
  defaultAgentId: uuid("default_agent_id").references(() => agentsTable.id, {
    onDelete: "set null",
  }),
});

export default member;
