import {
  boolean,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type {
  JiraChatOpsDeliveryMethod,
  JiraChatOpsEventState,
} from "@/types/jira-chatops-event";
import a2aTasksTable from "./a2a-task";

export const jiraChatOpsEventsTable = pgTable(
  "jira_chatops_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    integrationId: uuid("integration_id").notNull(),
    botId: uuid("bot_id").notNull(),
    organizationId: text("organization_id").notNull(),
    eventKey: text("event_key").notNull(),
    deliveryId: text("delivery_id"),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    state: text("state")
      .$type<JiraChatOpsEventState>()
      .notNull()
      .default("pending"),
    claimId: uuid("claim_id"),
    claimedAt: timestamp("claimed_at", { mode: "date" }),
    dispatchedAt: timestamp("dispatched_at", { mode: "date" }),
    taskId: uuid("task_id").references(() => a2aTasksTable.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { mode: "date" }),
  },
  (table) => [
    uniqueIndex("jira_chatops_events_revision_idx").on(
      table.integrationId,
      table.botId,
      table.eventKey,
    ),
    index("jira_chatops_events_status_idx").on(
      table.integrationId,
      table.state,
    ),
  ],
);

export const jiraChatOpsDeliveriesTable = pgTable(
  "jira_chatops_deliveries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    integrationId: uuid("integration_id").notNull(),
    botId: uuid("bot_id").notNull(),
    issueId: text("issue_id").notNull(),
    operationKey: text("operation_key").notNull(),
    bodyDigest: text("body_digest").notNull(),
    method: text("method")
      .$type<JiraChatOpsDeliveryMethod>()
      .notNull()
      .default("create"),
    commentId: text("comment_id"),
    postAttempted: boolean("post_attempted").notNull().default(false),
    claimId: uuid("claim_id"),
    claimedAt: timestamp("claimed_at", { mode: "date" }),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { mode: "date" }),
  },
  (table) => [
    uniqueIndex("jira_chatops_deliveries_operation_idx").on(
      table.integrationId,
      table.botId,
      table.operationKey,
    ),
    index("jira_chatops_deliveries_issue_idx").on(
      table.integrationId,
      table.botId,
      table.issueId,
    ),
  ],
);
