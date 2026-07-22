import {
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import type { ChatToolExecutionClaim } from "@/types";
import conversationsTable from "./conversation";

/**
 * At-most-once dispatch ledger for approval-gated chat tool calls (#5132).
 * The approval flow is client-driven, so a replayed approve (stale tab,
 * re-approve of a resolved turn) re-enters execute with the same
 * model-generated toolCallId; the UNIQUE(conversation_id, tool_call_id) claim
 * is what guarantees only one request dispatches to the external MCP server.
 * toolCallId is only unique within a conversation, hence the composite key.
 */
const chatToolExecutionClaimsTable = pgTable(
  "chat_tool_execution_claims",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversationsTable.id, { onDelete: "cascade" }),
    toolCallId: text("tool_call_id").notNull(),
    toolName: text("tool_name").notNull(),
    // executing → completed | failed. A row stuck in `executing` (crash or
    // abort after dispatch) keeps replays failing closed: the external write
    // may have happened, so re-running is never safe.
    state: text("state")
      .$type<ChatToolExecutionClaim.State>()
      .notNull()
      .default("executing"),
    // Bounded, sanitized replay payload (content text only, size-capped) —
    // never the verbatim MCP result, which can embed large binary content.
    result: jsonb("result").$type<ChatToolExecutionClaim.StoredResult | null>(),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "date" })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [unique().on(table.conversationId, table.toolCallId)],
);

export default chatToolExecutionClaimsTable;
