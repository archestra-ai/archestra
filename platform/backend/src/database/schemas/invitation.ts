import { index, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import organizationsTable from "./organization";
import usersTable from "./user";

const invitation = pgTable(
  "invitation",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizationsTable.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    role: text("role"),
    status: text("status").default("pending").notNull(),
    expiresAt: timestamp("expires_at").notNull(),
    inviterId: text("inviter_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => ({
    // The signup-status read looks up a member's auto-provisioned
    // invitation by organization and email.
    organizationEmailIdx: index("invitation_organization_id_email_idx").on(
      table.organizationId,
      table.email,
    ),
  }),
);

export default invitation;
