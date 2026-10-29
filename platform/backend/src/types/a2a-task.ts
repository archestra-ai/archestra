import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import { z } from "zod";
import { schema } from "@/database";

/**
 * A2A protocol task states, serialized exactly as the A2A v1.0 `TaskState`
 * proto enum. Lives here (not in a2a-protocol.ts) so the `a2a_task.state`
 * column can reference it via `$type<A2ATaskState>()` without the schema layer
 * importing from `agents/`.
 */
export const A2ATaskStateSchema = z.enum([
  "TASK_STATE_UNSPECIFIED",
  "TASK_STATE_SUBMITTED",
  "TASK_STATE_WORKING",
  "TASK_STATE_COMPLETED",
  "TASK_STATE_FAILED",
  "TASK_STATE_CANCELED",
  "TASK_STATE_INPUT_REQUIRED",
  "TASK_STATE_REJECTED",
  "TASK_STATE_AUTH_REQUIRED",
]);
export type A2ATaskState = z.infer<typeof A2ATaskStateSchema>;

/**
 * Terminal states are absorbing: once a task reaches one, no transition,
 * message, cancellation, or subscription may move it again (A2A v1.0 §3.1.1).
 */
export const A2A_TERMINAL_TASK_STATES: readonly A2ATaskState[] = [
  "TASK_STATE_COMPLETED",
  "TASK_STATE_FAILED",
  "TASK_STATE_CANCELED",
  "TASK_STATE_REJECTED",
];

export function isTerminalA2ATaskState(state: A2ATaskState): boolean {
  return A2A_TERMINAL_TASK_STATES.includes(state);
}

/**
 * Machine-readable classification of a FAILED Agent Runtime task, stored next
 * to its human-readable `statusReason`. The code vocabulary and its retry
 * semantics live in `services/agent-runtime/run-failure.ts`.
 */
export const A2ATaskFailureSchema = z.object({
  code: z.string().min(1).max(160),
  retriable: z.boolean(),
});
export type A2ATaskFailure = z.infer<typeof A2ATaskFailureSchema>;

export const SelectA2ATaskSchema = createSelectSchema(schema.a2aTasksTable, {
  state: A2ATaskStateSchema,
  failure: A2ATaskFailureSchema.nullable(),
});
export const InsertA2ATaskSchema = createInsertSchema(schema.a2aTasksTable, {
  state: A2ATaskStateSchema,
  failure: A2ATaskFailureSchema.nullable().optional(),
}).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type A2ATask = z.infer<typeof SelectA2ATaskSchema>;
export type InsertA2ATask = z.infer<typeof InsertA2ATaskSchema>;
