import {
  boolean,
  index,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import agentRunsTable from "./agent-run";

/** One Slack message per input-required episode; never contains runtime input. */
const agentRunAttentionNoticesTable = pgTable(
  "agent_run_attention_notices",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    taskId: uuid("task_id")
      .notNull()
      .references(() => agentRunsTable.taskId, { onDelete: "cascade" }),
    channelId: text("channel_id").notNull(),
    workspaceId: text("workspace_id"),
    resolved: boolean("resolved").notNull().default(false),
    messageTs: text("message_ts"),
    postAttempted: boolean("post_attempted").notNull().default(false),
    resolvedNotified: boolean("resolved_notified").notNull().default(false),
    claimId: uuid("claim_id"),
    claimedAt: timestamp("claimed_at", { mode: "date" }),
  },
  (table) => [
    index("agent_run_attention_notices_task_id_idx").on(table.taskId),
  ],
);

export default agentRunAttentionNoticesTable;
