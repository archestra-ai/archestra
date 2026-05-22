import type { UIMessageChunk } from "ai";
import { sql } from "drizzle-orm";
import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type { ChatActiveRunStatus } from "@/types/chat-active-run";
import conversationsTable from "./conversation";

const chatActiveRunsTable = pgTable(
  "chat_active_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversationsTable.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull(),
    organizationId: text("organization_id").notNull(),
    status: text("status").$type<ChatActiveRunStatus>().notNull(),
    stopRequestedAt: timestamp("stop_requested_at", { mode: "date" }),
    error: text("error"),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "date" })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => ({
    conversationIdIdx: index("chat_active_runs_conversation_id_idx").on(
      table.conversationId,
    ),
    runningConversationIdx: uniqueIndex(
      "chat_active_runs_running_conversation_uidx",
    )
      .on(table.conversationId)
      .where(sql`${table.status} = 'running'`),
    runningUpdatedAtIdx: index("chat_active_runs_running_updated_at_idx")
      .on(table.updatedAt)
      .where(sql`${table.status} = 'running'`),
    terminalUpdatedAtIdx: index("chat_active_runs_terminal_updated_at_idx")
      .on(table.updatedAt)
      .where(sql`${table.status} != 'running'`),
  }),
);

const chatActiveRunEventsTable = pgTable(
  "chat_active_run_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id")
      .notNull()
      .references(() => chatActiveRunsTable.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    payloads: jsonb("payloads").$type<UIMessageChunk[]>().notNull(),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  },
  (table) => ({
    runSeqUnique: unique("chat_active_run_events_run_id_seq_uidx").on(
      table.runId,
      table.seq,
    ),
  }),
);

export { chatActiveRunEventsTable, chatActiveRunsTable };
