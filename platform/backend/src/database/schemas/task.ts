import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type { TaskStatus, TaskType } from "@/types/task";

const tasksTable = pgTable(
  "tasks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    taskType: text("task_type").$type<TaskType>().notNull(),
    payload: jsonb("payload")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    status: text("status").$type<TaskStatus>().notNull().default("pending"),
    attempt: integer("attempt").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(5),
    scheduledFor: timestamp("scheduled_for", { mode: "date" })
      .notNull()
      .defaultNow(),
    startedAt: timestamp("started_at", { mode: "date" }),
    completedAt: timestamp("completed_at", { mode: "date" }),
    lastError: text("last_error"),
    periodic: boolean("periodic").notNull().default(false),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    index("tasks_dequeue_idx").on(
      table.taskType,
      table.status,
      table.scheduledFor,
    ),
    uniqueIndex("tasks_unique_periodic_idx")
      .on(table.taskType)
      .where(
        sql`${table.periodic} = true AND ${table.status} IN ('pending', 'processing')`,
      ),
  ],
);

export default tasksTable;
