import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type {
  EvalAssertion,
  EvalAssertionResult,
  EvalRunResultStatus,
} from "@/types/eval";
import evalCasesTable from "./eval-case";
import evalRunsTable from "./eval-run";

/**
 * Per-case outcome of an eval run. Case name/messages/assertions are snapshotted
 * at run creation so results stay meaningful after the case is edited or
 * deleted (`caseId` goes null on case delete).
 */
const evalRunResultsTable = pgTable(
  "eval_run_results",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id")
      .notNull()
      .references(() => evalRunsTable.id, { onDelete: "cascade" }),
    caseId: uuid("case_id").references(() => evalCasesTable.id, {
      onDelete: "set null",
    }),
    // Snapshots taken at run creation.
    caseName: text("case_name").notNull(),
    messages: jsonb("messages").$type<string[]>().notNull(),
    assertions: jsonb("assertions").$type<EvalAssertion[]>().notNull(),
    position: integer("position").notNull(),
    status: text("status")
      .$type<EvalRunResultStatus>()
      .notNull()
      .default("pending"),
    /** Final assistant text returned by the agent. */
    outputText: text("output_text"),
    finishReason: text("finish_reason"),
    /** Ordered top-level tool names the agent called (nested calls excluded). */
    toolCalls: jsonb("tool_calls").$type<string[]>(),
    /** One entry per assertion, in assertion order. */
    assertionResults: jsonb("assertion_results").$type<EvalAssertionResult[]>(),
    error: text("error"),
    /** LLM proxy session of the agent execution (cost/trace drill-down). */
    sessionId: text("session_id"),
    /** LLM proxy session of the llm_judge call, when one ran. */
    judgeSessionId: text("judge_session_id"),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    totalTokens: integer("total_tokens"),
    durationMs: integer("duration_ms"),
    startedAt: timestamp("started_at", { mode: "date" }),
    completedAt: timestamp("completed_at", { mode: "date" }),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "date" })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex("eval_run_results_run_id_case_id_idx").on(
      table.runId,
      table.caseId,
    ),
    index("eval_run_results_run_id_position_idx").on(
      table.runId,
      table.position,
    ),
  ],
);

export default evalRunResultsTable;
