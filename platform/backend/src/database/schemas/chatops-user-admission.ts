import { index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import usersTable from "./user";

/** A live ChatOps invocation must finish before its pending user is retired. */
const chatopsUserAdmissionsTable = pgTable(
  "chatops_user_admissions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  },
  (table) => [index("chatops_user_admissions_user_id_idx").on(table.userId)],
);

export default chatopsUserAdmissionsTable;
