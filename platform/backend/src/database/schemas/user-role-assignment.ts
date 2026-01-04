import { pgTable, text, timestamp, unique } from "drizzle-orm/pg-core";
import usersTable from "./user";
import { role } from "./role";

export const userRoleAssignment = pgTable(
  "user_role_assignment",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    roleId: text("role_id")
      .notNull()
      .references(() => role.id, { onDelete: "cascade" }),
    assignedAt: timestamp("assigned_at").notNull().defaultNow(),
  },
  (table) => [
    unique().on(table.userId, table.roleId),
  ],
);

export default userRoleAssignment;
