import {
  index,
  integer,
  jsonb,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type { A2AProtocolStreamResponse } from "@/agents/a2a/a2a-protocol";
import a2aTaskTable from "./a2a-task";

/**
 * Ordered per-task stream-event log backing `SubscribeToTask` (mirrors
 * `chat_active_run` events): each row is one protocol StreamResponse frame
 * (statusUpdate / artifactUpdate), sequenced by `a2a_task.next_event_seq`
 * inside the same transaction that inserts it. Terminal events commit
 * atomically with the task's terminal state, so a subscriber that observes a
 * terminal state has necessarily been offered every event.
 *
 * These rows are subscription transport, not the durable record — the task,
 * its messages, and its artifacts are. Events of terminal tasks are
 * opportunistically deleted after a retention window.
 */
const a2aTaskEventTable = pgTable(
  "a2a_task_event",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    taskId: uuid("task_id")
      .notNull()
      .references(() => a2aTaskTable.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    payload: jsonb("payload").$type<A2AProtocolStreamResponse>().notNull(),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("a2a_task_event_task_id_seq_idx").on(table.taskId, table.seq),
    index("a2a_task_event_created_at_idx").on(table.createdAt),
  ],
);

export default a2aTaskEventTable;
