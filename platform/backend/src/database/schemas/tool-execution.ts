import {
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import type { ToolExecutionState } from "@/types/tool-execution";

/**
 * At-most-once ledger for approval-gated tool executions.
 *
 * The `require_approval` policy must guarantee "one approval → at most one
 * external execution". Concurrent approvals of the same tool call — e.g. the
 * same pending turn approved in two tabs — each fire an independent execute
 * request; with no shared gate both dispatch to the MCP server and cause a
 * double external write (two GitHub issues, two charges, ...).
 *
 * A row here is atomically claimed on `tool_call_id`
 * (`INSERT ... ON CONFLICT DO NOTHING`) before dispatch, so only the request
 * that wins the claim calls the MCP server; the others read back the recorded
 * `result` instead of executing again.
 */
const toolExecutionsTable = pgTable(
  "tool_executions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // AI SDK tool call id — stable across an approval, unique per tool call.
    toolCallId: text("tool_call_id").notNull(),
    state: text("state")
      .$type<ToolExecutionState>()
      .notNull()
      .default("executing"),
    // Recorded tool result, returned to concurrent callers that lost the claim
    // so every tab sees the same outcome without triggering a second execution.
    result: jsonb("result").$type<unknown>(),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "date" })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    unique("tool_executions_tool_call_id_unique").on(table.toolCallId),
  ],
);

export default toolExecutionsTable;
