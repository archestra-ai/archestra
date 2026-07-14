import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import { z } from "zod";
import { schema } from "@/database";

/**
 * Lifecycle of a single approval-gated tool execution, keyed on the AI SDK
 * tool call id:
 * - `executing` — a request has claimed the call and is dispatching to MCP.
 * - `completed` — the MCP call returned; `result` holds the recorded output.
 * - `failed` — the MCP call threw; `result` holds an error summary.
 */
export const ToolExecutionStateSchema = z.enum([
  "executing",
  "completed",
  "failed",
]);
export type ToolExecutionState = z.infer<typeof ToolExecutionStateSchema>;

export const SelectToolExecutionSchema = createSelectSchema(
  schema.toolExecutionsTable,
  {
    state: ToolExecutionStateSchema,
    // result mirrors the executed tool's output, whose shape varies by tool
    result: z.unknown().nullable(),
  },
);
export const InsertToolExecutionSchema = createInsertSchema(
  schema.toolExecutionsTable,
  {
    state: ToolExecutionStateSchema.optional(),
    result: z.unknown().nullable(),
  },
).omit({ id: true, createdAt: true, updatedAt: true });

export type ToolExecution = z.infer<typeof SelectToolExecutionSchema>;
export type InsertToolExecution = z.infer<typeof InsertToolExecutionSchema>;
