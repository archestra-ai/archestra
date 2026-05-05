import {
  boolean,
  index,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import a2aTaskTable from "./a2a-task";

const a2aTaskApprovalRequestTable = pgTable(
  "a2a_task_approval_request",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    taskId: uuid("task_id")
      .notNull()
      .references(() => a2aTaskTable.id, { onDelete: "cascade" }),
    approvalId: text("approval_id").notNull(),
    toolCallId: text("tool_call_id").notNull(),
    toolName: text("tool_name").notNull(),
    approved: boolean("approved").notNull().default(false),
    resolved: boolean("resolved").notNull().default(false),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "date" })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    index("a2a_task_approval_request_task_id_approval_id_idx").on(
      table.taskId,
      table.approvalId,
    ),
  ],
);

export default a2aTaskApprovalRequestTable;
