import {
  bigint,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import a2aTaskTable from "./a2a-task";

/**
 * The OpenAPPA release receipts of the content an A2A task's finalized parts
 * hold. A read of the task is judged on the meet of their labels; a task with
 * no receipt releases its status only.
 */
const a2aTaskReleaseReceiptsTable = pgTable(
  "a2a_task_release_receipts",
  {
    taskId: uuid("task_id")
      .notNull()
      .references(() => a2aTaskTable.id, { onDelete: "cascade" }),
    session: text("session").notNull(),
    factPosition: bigint("fact_position", { mode: "number" }).notNull(),
    digest: varchar("digest", { length: 64 }).notNull(),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({
      columns: [table.taskId, table.session, table.factPosition],
    }),
  ],
);

export default a2aTaskReleaseReceiptsTable;
