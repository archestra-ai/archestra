import {
  createInsertSchema,
  createSelectSchema,
  createUpdateSchema,
} from "drizzle-zod";
import { z } from "zod";
import { schema } from "@/database";

// === Statuses ===

/** Lifecycle of a whole eval run (one enqueued execution of a suite). */
export const EvalRunStatusSchema = z.enum([
  "pending",
  "running",
  "completed",
  "failed",
  "canceled",
]);
export type EvalRunStatus = z.infer<typeof EvalRunStatusSchema>;

/**
 * Lifecycle of a single case within a run. `failed` = the agent responded but
 * at least one assertion did not pass; `error` = the case could not be
 * evaluated (agent call or judge call errored, timeout, crash interruption).
 */
export const EvalRunResultStatusSchema = z.enum([
  "pending",
  "running",
  "passed",
  "failed",
  "error",
  "canceled",
]);
export type EvalRunResultStatus = z.infer<typeof EvalRunResultStatusSchema>;

// === Assertions ===

export const EVAL_ASSERTION_TYPES = [
  "exact_match",
  "contains",
  "not_contains",
  "regex",
  "tool_called",
  "tool_not_called",
  "llm_judge",
] as const;
export const EvalAssertionTypeSchema = z.enum(EVAL_ASSERTION_TYPES);
export type EvalAssertionType = z.infer<typeof EvalAssertionTypeSchema>;

/** Output must equal `expected` (after optional trim / case folding). */
const ExactMatchAssertionSchema = z.object({
  type: z.literal("exact_match"),
  expected: z.string(),
  caseSensitive: z.boolean().optional().default(false),
  trim: z.boolean().optional().default(true),
});

/** Output must contain all (or any) of `values`. */
const ContainsAssertionSchema = z.object({
  type: z.literal("contains"),
  values: z.array(z.string().min(1)).min(1).max(50),
  mode: z.enum(["all", "any"]).optional().default("all"),
  caseSensitive: z.boolean().optional().default(false),
});

/** Output must contain none of `values` (canary / leak checks). */
const NotContainsAssertionSchema = z.object({
  type: z.literal("not_contains"),
  values: z.array(z.string().min(1)).min(1).max(50),
  caseSensitive: z.boolean().optional().default(false),
});

/** Output must match the regular expression. Validated at write time. */
const RegexAssertionSchema = z
  .object({
    type: z.literal("regex"),
    pattern: z.string().min(1).max(1000),
    flags: z
      .string()
      .regex(/^[imsu]*$/, "flags may only contain i, m, s, u")
      .optional(),
  })
  .superRefine((value, ctx) => {
    try {
      new RegExp(value.pattern, value.flags);
    } catch (error) {
      ctx.addIssue({
        code: "custom",
        message: `invalid regex pattern: ${error instanceof Error ? error.message : String(error)}`,
        path: ["pattern"],
      });
    }
  });

/**
 * The agent's top-level trajectory must include a call to every named tool.
 * Nested (delegated subagent) tool calls are not inspected in the alpha.
 */
const ToolCalledAssertionSchema = z.object({
  type: z.literal("tool_called"),
  toolNames: z.array(z.string().min(1)).min(1).max(50),
});

/** The agent's top-level trajectory must call none of the named tools. */
const ToolNotCalledAssertionSchema = z.object({
  type: z.literal("tool_not_called"),
  toolNames: z.array(z.string().min(1)).min(1).max(50),
});

/**
 * An LLM judge grades the output against free-form `criteria` (optionally with
 * a reference `expected` answer) and returns pass/fail with a reason.
 */
const LlmJudgeAssertionSchema = z.object({
  type: z.literal("llm_judge"),
  criteria: z.string().min(1).max(10_000),
  expected: z.string().max(10_000).optional(),
});

export const EvalAssertionSchema = z.discriminatedUnion("type", [
  ExactMatchAssertionSchema,
  ContainsAssertionSchema,
  NotContainsAssertionSchema,
  RegexAssertionSchema,
  ToolCalledAssertionSchema,
  ToolNotCalledAssertionSchema,
  LlmJudgeAssertionSchema,
]);
export type EvalAssertion = z.infer<typeof EvalAssertionSchema>;

/** Assertions stored on a case: at least one, bounded to keep runs tractable. */
export const EvalCaseAssertionsSchema = z
  .array(EvalAssertionSchema)
  .min(1)
  .max(20);

/** Outcome of one assertion against one case output. */
export const EvalAssertionResultSchema = z.object({
  type: EvalAssertionTypeSchema,
  passed: z.boolean(),
  reason: z.string(),
});
export type EvalAssertionResult = z.infer<typeof EvalAssertionResultSchema>;

// === Suites ===

export const SelectEvalSuiteSchema = createSelectSchema(schema.evalSuitesTable);
export const InsertEvalSuiteSchema = createInsertSchema(
  schema.evalSuitesTable,
).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
  deletedAt: true,
});
export const UpdateEvalSuiteSchema = createUpdateSchema(
  schema.evalSuitesTable,
).pick({
  name: true,
  description: true,
});

export type EvalSuite = z.infer<typeof SelectEvalSuiteSchema>;
export type InsertEvalSuite = z.infer<typeof InsertEvalSuiteSchema>;
export type UpdateEvalSuite = z.infer<typeof UpdateEvalSuiteSchema>;

// === Cases ===

export const SelectEvalCaseSchema = createSelectSchema(schema.evalCasesTable, {
  assertions: EvalCaseAssertionsSchema,
});
// `position` is owned by the model (appended at max+1), not by callers.
export const InsertEvalCaseSchema = createInsertSchema(schema.evalCasesTable, {
  assertions: EvalCaseAssertionsSchema,
}).omit({
  id: true,
  position: true,
  createdAt: true,
  updatedAt: true,
});
export const UpdateEvalCaseSchema = createUpdateSchema(schema.evalCasesTable, {
  assertions: EvalCaseAssertionsSchema.optional(),
}).pick({
  name: true,
  input: true,
  assertions: true,
});

export type EvalCase = z.infer<typeof SelectEvalCaseSchema>;
export type InsertEvalCase = z.infer<typeof InsertEvalCaseSchema>;
export type UpdateEvalCase = z.infer<typeof UpdateEvalCaseSchema>;

// === Runs ===

export const SelectEvalRunSchema = createSelectSchema(schema.evalRunsTable, {
  status: EvalRunStatusSchema,
});
export type EvalRun = z.infer<typeof SelectEvalRunSchema>;

// === Run results ===

export const SelectEvalRunResultSchema = createSelectSchema(
  schema.evalRunResultsTable,
  {
    status: EvalRunResultStatusSchema,
    assertions: EvalCaseAssertionsSchema,
    toolCalls: z.array(z.string()).nullable(),
    assertionResults: z.array(EvalAssertionResultSchema).nullable(),
  },
);
export type EvalRunResult = z.infer<typeof SelectEvalRunResultSchema>;
