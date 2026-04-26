import {
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import agentsTable from "./agent";
import usersTable from "./user";

/**
 * Stores pending approval requests from ChatOps sessions.
 *
 * When a ChatOps agent (Slack/Teams) hits a tool that requires human approval,
 * execution is paused, an interactive message is sent to the channel, and a
 * record is created here.  When the user clicks Approve or Decline, the record
 * is updated and the agent resumes (approve) or sends a refusal message
 * (decline).
 *
 * Approval tokens are random UUIDs embedded in Slack/Teams button values so
 * that they cannot be guessed.  Tokens expire after CHATOPS_APPROVAL_EXPIRY_MS
 * (24 h by default).
 */
const chatopsApprovalRequestsTable = pgTable(
  "chatops_approval_request",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    /** Unique token embedded in the interactive button value */
    token: varchar("token", { length: 128 }).notNull().unique(),

    /** Provider that created the request ("slack" | "ms-teams") */
    provider: varchar("provider", { length: 32 }).notNull(),

    /** Channel the original message came from */
    channelId: varchar("channel_id", { length: 256 }).notNull(),

    /** Workspace / team ID for the provider */
    workspaceId: varchar("workspace_id", { length: 256 }),

    /** Thread timestamp / thread ID for the conversation */
    threadId: varchar("thread_id", { length: 256 }),

    /** Slack message timestamp of the approval card (used to update it later) */
    approvalMessageTs: varchar("approval_message_ts", { length: 64 }),

    /** Agent that is awaiting approval */
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agentsTable.id, { onDelete: "cascade" }),

    /** User who sent the original message */
    userId: text("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),

    /** Tool name that requires approval */
    toolName: varchar("tool_name", { length: 512 }).notNull(),

    /** Tool arguments as JSON */
    toolArgs: jsonb("tool_args").notNull(),

    /**
     * Serialised execution context needed to re-run the agent after approval.
     * Contains: organizationId, sessionId, source, fullMessage, attachments, etc.
     */
    executionContext: jsonb("execution_context").notNull(),

    /**
     * Serialised IncomingChatMessage needed to send the reply after resumption.
     */
    originalMessage: jsonb("original_message").notNull(),

    /** "pending" → "approved" | "declined" | "expired" */
    status: varchar("status", { length: 32 }).notNull().default("pending"),

    /** When the request was created */
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),

    /** When the request expires (defaults to 24 h after creation) */
    expiresAt: timestamp("expires_at", { mode: "date" }).notNull(),

    /** When the user responded */
    resolvedAt: timestamp("resolved_at", { mode: "date" }),
  },
  (table) => [
    index("chatops_approval_request_token_idx").on(table.token),
    index("chatops_approval_request_status_idx").on(table.status),
    index("chatops_approval_request_expires_at_idx").on(table.expiresAt),
    index("chatops_approval_request_agent_id_idx").on(table.agentId),
  ],
);

export default chatopsApprovalRequestsTable;
