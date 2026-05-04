import {
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import a2aContextTable from "./a2a-context";
import a2aTaskTable from "./a2a-task";

const a2aMessageTable = pgTable(
  "a2a_message",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    contextId: uuid("context_id")
      .notNull()
      .references(() => a2aContextTable.id, { onDelete: "cascade" }),
    taskId: uuid("task_id").references(() => a2aTaskTable.id, {
      onDelete: "cascade",
    }),
    role: text("role").notNull(),
    parts: jsonb("parts").$type<unknown[]>().notNull(),
    content: jsonb("content").$type<unknown>().notNull(),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "date" })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    index("a2a_message_context_id_idx").on(table.contextId, table.createdAt),
    index("a2a_message_task_id_idx").on(table.taskId, table.createdAt),
    index("a2a_message_updated_at_idx").on(table.updatedAt),
  ],
);

export default a2aMessageTable;
