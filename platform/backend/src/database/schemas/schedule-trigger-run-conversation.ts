import {
  index,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import conversationsTable from "./conversation";
import scheduleTriggerRunsTable from "./schedule-trigger-run";

const scheduleTriggerRunConversationsTable = pgTable(
  "schedule_trigger_run_conversations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id")
      .notNull()
      .references(() => scheduleTriggerRunsTable.id, { onDelete: "cascade" }),
    userId: varchar("user_id", { length: 255 }).notNull(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversationsTable.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "date" })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    index("schedule_trigger_run_conversations_run_id_idx").on(table.runId),
    index("schedule_trigger_run_conversations_user_id_idx").on(table.userId),
    uniqueIndex("schedule_trigger_run_conversations_run_user_unique_idx").on(
      table.runId,
      table.userId,
    ),
    uniqueIndex(
      "schedule_trigger_run_conversations_conversation_unique_idx",
    ).on(table.conversationId),
  ],
);

export default scheduleTriggerRunConversationsTable;
