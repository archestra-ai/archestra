import { index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import a2aContextTable from "./a2a-context";

const a2aTaskTable = pgTable(
  "a2a_task",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    contextId: uuid("context_id")
      .notNull()
      .references(() => a2aContextTable.id, { onDelete: "cascade" }),
    state: text("state").notNull(),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "date" })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    index("a2a_task_context_id_idx").on(table.contextId),
    index("a2a_task_updated_at_idx").on(table.updatedAt),
  ],
);

export default a2aTaskTable;
