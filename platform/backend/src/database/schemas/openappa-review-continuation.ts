import {
  boolean,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import type { A2AProtocolSendMessageResponse } from "@/agents/a2a/a2a-protocol";
import type { ReviewOrigin } from "@/openappa/review-origin";
import type { ReviewContinuationState } from "@/types/openappa-review-continuation";
import a2aTasksTable from "./a2a-task";
import organizationsTable from "./organization";
import usersTable from "./user";

export const openappaReviewContinuationsTable = pgTable(
  "openappa_review_continuations",
  {
    id: uuid().primaryKey().defaultRandom(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizationsTable.id, { onDelete: "cascade" }),
    actorUserId: text("actor_user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    taskId: uuid("task_id")
      .notNull()
      .references(() => a2aTasksTable.id, { onDelete: "cascade" }),
    approvalId: text("approval_id").notNull(),
    approved: boolean().notNull(),
    agentId: uuid("agent_id").notNull(),
    sessionId: text("session_id").notNull(),
    origin: jsonb().$type<ReviewOrigin>().notNull(),
    state: text().$type<ReviewContinuationState>().notNull().default("queued"),
    claimId: uuid("claim_id"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    result: jsonb().$type<A2AProtocolSendMessageResponse>(),
    deliveryEventId: text("delivery_event_id"),
    failureReason: text("failure_reason"),
  },
  (table) => [
    unique("openappa_review_continuation_approval_idx").on(
      table.taskId,
      table.approvalId,
    ),
    index("openappa_review_continuation_work_idx").on(
      table.state,
      table.updatedAt,
    ),
  ],
);
