import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import a2aTaskTable from "./a2a-task";
import usersTable from "./user";

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
    // OpenAPPA human review: set only when the paused call is the
    // `execute_remedy_plan` for an offer that needs the `hitl` authority.
    // The blocked action itself lives in OpenAPPA's tables.
    openappaOfferId: text("openappa_offer_id"),
    openappaReviewText: text("openappa_review_text"),
    /** The exact `execute_remedy_plan` arguments, proxy stamps included. */
    remedyArguments: jsonb("remedy_arguments").$type<Record<string, unknown>>(),
    /** The only user who may decide; their decision sets ruling + decidedAt. */
    reviewerUserId: text("reviewer_user_id").references(() => usersTable.id, {
      onDelete: "cascade",
    }),
    slackChannelId: text("slack_channel_id"),
    slackThreadTs: text("slack_thread_ts"),
    expiresAt: timestamp("expires_at", { mode: "date" }),
    ruling: text("ruling").$type<"approve" | "deny">(),
    decidedAt: timestamp("decided_at", { mode: "date" }),
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
    index("a2a_task_approval_request_openappa_expiry_idx")
      .on(table.expiresAt)
      .where(sql`${table.openappaOfferId} IS NOT NULL`),
  ],
);

export default a2aTaskApprovalRequestTable;
