import z from "zod";
import { A2ATaskStateSchema } from "@/types/a2a-task";

/**
 * Types and schemas for the A2A Protocol.
 * Types and schemas with name starting with "A2AArchestra"
 *   are for Archestra A2A Protocol extensions in metadata.
 */

/**
 * Wire-shape variant negotiated per request via the `A2A-Version` header.
 * The A2A spec mandates that an absent or empty header means pre-1.0
 * semantics, which is exactly the stream shape this endpoint has always
 * served ("legacy": statusUpdate-first frames carrying a `final` flag).
 * `A2A-Version: 1.0` (and, until real negotiation exists, anything else
 * explicitly set) selects the strict v1.0 lifecycle shape: an initial `task`
 * frame, `artifactUpdate` frames, and no `final` field.
 */
export type A2AProtocolVersion = "legacy" | "v1";

export function resolveA2AProtocolVersion(
  header: string | string[] | undefined,
): A2AProtocolVersion {
  const value = Array.isArray(header) ? header[0] : header;
  if (!value || value.trim() === "" || value.trim() === "0.3") {
    return "legacy";
  }
  return "v1";
}

export enum A2AProtocolRole {
  Unspecified = "ROLE_UNSPECIFIED",
  User = "ROLE_USER",
  Agent = "ROLE_AGENT",
}

// --- Archestra Task Ops ---
export const A2AArchestraTaskApprovalDecisionSchema = z.object({
  approvalId: z.string(),
  approved: z.boolean(),
});
export type A2AArchestraTaskApprovalDecision = z.infer<
  typeof A2AArchestraTaskApprovalDecisionSchema
>;

export const A2AArchestraTaskOpsSchema = z.object({
  approvalDecisions: z.array(A2AArchestraTaskApprovalDecisionSchema).optional(),
});
export type A2AArchestraTaskOps = z.infer<typeof A2AArchestraTaskOpsSchema>;

// --- A2A Message
const A2AArchestraMessageMetadataSchema = z.object({
  taskOps: A2AArchestraTaskOpsSchema.optional(),
});

const Uint8ArraySchema: z.ZodType<Uint8Array<ArrayBufferLike>> =
  z.instanceof(Uint8Array);

export const A2AProtocolPartSchema = z.object({
  text: z.string().optional(),
  raw: Uint8ArraySchema.optional(),
  url: z.string().optional(),
  data: z.any().optional(),
  metadata: z.any().optional(),
  filename: z.string().optional(),
  mediaType: z.string().optional(),
});
export type A2AProtocolPart = z.infer<typeof A2AProtocolPartSchema>;

export const A2AProtocolMessageSchema = z.object({
  messageId: z.string(),
  contextId: z.string().optional(),
  taskId: z.string().optional(),
  role: z.enum(A2AProtocolRole),
  // `parts` is required by A2A Protocol, but we allow undefined value
  //    because of some client SDK implementations.
  parts: z.array(A2AProtocolPartSchema).optional(),
  metadata: A2AArchestraMessageMetadataSchema.optional(),
  extensions: z.array(z.string()).optional(),
  referenceTaskIds: z.array(z.string()).optional(),
});
export type A2AProtocolMessage = z.infer<typeof A2AProtocolMessageSchema>;

// --- Archestra Task metadata ---

export const A2AArchestraApprovalRequestSchema = z.object({
  approvalId: z.string(),
  toolCallId: z.string(),
  toolName: z.string(),
  // Arguments the tool was called with. Carried so human-facing approval
  // prompts (e.g. ChatOps) can show what the tool will do, and so a `run_tool`
  // dispatch can be unwrapped to the real target tool + its args. Optional
  // because it is only populated on the live (in-memory) approval path; tasks
  // reloaded from the database do not persist it.
  toolInput: z.record(z.string(), z.unknown()).optional(),
  approved: z.boolean(),
  resolved: z.boolean(),
});
export type A2AArchestraApprovalRequest = z.infer<
  typeof A2AArchestraApprovalRequestSchema
>;

const A2AArchestraTaskMetadataSchema = z.object({
  approvalRequests: z.array(A2AArchestraApprovalRequestSchema).optional(),
});

// --- A2A Task ---

/** A2A v1.0 `Artifact`: a task output, distinct from conversational messages. */
export const A2AProtocolArtifactSchema = z.object({
  artifactId: z.string(),
  name: z.string().optional(),
  description: z.string().optional(),
  parts: z.array(A2AProtocolPartSchema).min(1),
  metadata: z.any().optional(),
  extensions: z.array(z.string()).optional(),
});
export type A2AProtocolArtifact = z.infer<typeof A2AProtocolArtifactSchema>;

/**
 * Enum-style accessor over the wire values in {@link A2ATaskStateSchema}
 * (single source of truth, shared with the `a2a_task.state` column type).
 */
export const A2AProtocolTaskState = {
  Unspecified: "TASK_STATE_UNSPECIFIED",
  Submitted: "TASK_STATE_SUBMITTED",
  Working: "TASK_STATE_WORKING",
  Completed: "TASK_STATE_COMPLETED",
  Failed: "TASK_STATE_FAILED",
  Canceled: "TASK_STATE_CANCELED",
  InputRequired: "TASK_STATE_INPUT_REQUIRED",
  Rejected: "TASK_STATE_REJECTED",
  AuthRequired: "TASK_STATE_AUTH_REQUIRED",
} as const satisfies Record<string, A2AProtocolTaskState>;
export type A2AProtocolTaskState = z.infer<typeof A2ATaskStateSchema>;

const A2AProtocolTaskStatusSchema = z.object({
  state: A2ATaskStateSchema,
  message: A2AProtocolMessageSchema.optional(),
  /** RFC 3339 datetime (protobuf JSON `google.protobuf.Timestamp`). */
  timestamp: z.iso.datetime().optional(),
});
export type A2AProtocolTaskStatus = z.infer<typeof A2AProtocolTaskStatusSchema>;

export const A2AProtocolTaskSchema = z.object({
  id: z.string(),
  contextId: z.string().optional(),
  status: A2AProtocolTaskStatusSchema,
  artifacts: z.array(A2AProtocolArtifactSchema).optional(),
  history: z.array(A2AProtocolMessageSchema).optional(),
  metadata: A2AArchestraTaskMetadataSchema.optional(),
});
export type A2AProtocolTask = z.infer<typeof A2AProtocolTaskSchema>;

/**
 * A2A v1.0 `history_length` semantics, shared by GetTask, ListTasks, and
 * SendMessageConfiguration: unset = server default (full history), 0 = omit
 * the `history` field entirely, N > 0 = at most the N most recent messages.
 */
const A2AProtocolHistoryLengthSchema = z.number().int().nonnegative();

export const A2AProtocolGetTaskRequestSchema = z.object({
  tenant: z.string().optional(),
  id: z.string(),
  historyLength: A2AProtocolHistoryLengthSchema.optional(),
});
export type A2AProtocolGetTaskRequest = z.infer<
  typeof A2AProtocolGetTaskRequestSchema
>;

// --- A2A CancelTask / SubscribeToTask / ListTasks ---

export const A2AProtocolCancelTaskRequestSchema = z.object({
  tenant: z.string().optional(),
  id: z.string(),
  metadata: z.any().optional(),
});
export type A2AProtocolCancelTaskRequest = z.infer<
  typeof A2AProtocolCancelTaskRequestSchema
>;

export const A2AProtocolSubscribeToTaskRequestSchema = z.object({
  tenant: z.string().optional(),
  id: z.string(),
});
export type A2AProtocolSubscribeToTaskRequest = z.infer<
  typeof A2AProtocolSubscribeToTaskRequestSchema
>;

export const A2AProtocolListTasksRequestSchema = z.object({
  tenant: z.string().optional(),
  contextId: z.string().optional(),
  status: A2ATaskStateSchema.optional(),
  pageSize: z.number().int().min(1).max(100).optional(),
  pageToken: z.string().optional(),
  historyLength: A2AProtocolHistoryLengthSchema.optional(),
  /** RFC 3339 datetime; only tasks whose status changed after it are returned. */
  statusTimestampAfter: z.iso.datetime().optional(),
  /** Defaults to false, in which case `artifacts` is omitted from every task. */
  includeArtifacts: z.boolean().optional(),
});
export type A2AProtocolListTasksRequest = z.infer<
  typeof A2AProtocolListTasksRequestSchema
>;

export const A2AProtocolListTasksResponseSchema = z.object({
  tasks: z.array(A2AProtocolTaskSchema),
  nextPageToken: z.string(),
  pageSize: z.number().int(),
  totalSize: z.number().int(),
});
export type A2AProtocolListTasksResponse = z.infer<
  typeof A2AProtocolListTasksResponseSchema
>;

// --- A2A Send Message ---

const A2AProtocolSendMessageConfigurationSchema = z.object({
  /**
   * A2A v1.0 `return_immediately` (default false = blocking, the INVERSE of
   * the pre-1.0 `blocking` flag): when true the server creates the task,
   * returns its handle right away, and the run continues detached — the
   * caller polls GetTask or opens SubscribeToTask.
   */
  returnImmediately: z.boolean().optional(),
  historyLength: A2AProtocolHistoryLengthSchema.optional(),
});

export const A2AProtocolSendMessageRequestSchema = z.object({
  tenant: z.string().optional(),
  message: A2AProtocolMessageSchema,
  configuration: A2AProtocolSendMessageConfigurationSchema.optional(),
  metadata: z.any().optional(),
});
export type A2AProtocolSendMessageRequest = z.infer<
  typeof A2AProtocolSendMessageRequestSchema
>;

export const A2AProtocolSendMessageResponseSchema = z.object({
  message: A2AProtocolMessageSchema.optional(),
  task: A2AProtocolTaskSchema.optional(),
});
export type A2AProtocolSendMessageResponse = z.infer<
  typeof A2AProtocolSendMessageResponseSchema
>;

// --- A2A Streaming (SendStreamingMessage) ---

/**
 * Incremental task-state change emitted over a streaming response. Mirrors the
 * A2A v1.0 TaskStatusUpdateEvent (the `status.message` carries the partial or
 * final agent message for that update). `final` is NOT part of v1.0 — it is
 * the pre-1.0 end-of-stream marker, emitted only on the legacy wire shape
 * (see {@link A2AProtocolVersion}); v1.0 clients detect completion from the
 * task state plus stream closure.
 */
const A2AProtocolTaskStatusUpdateEventSchema = z.object({
  taskId: z.string(),
  contextId: z.string(),
  status: A2AProtocolTaskStatusSchema,
  final: z.boolean().optional(),
  metadata: z.any().optional(),
});
export type A2AProtocolTaskStatusUpdateEvent = z.infer<
  typeof A2AProtocolTaskStatusUpdateEventSchema
>;

/**
 * A2A v1.0 TaskArtifactUpdateEvent: one chunk of a task artifact. Chunked
 * delivery repeats the same `artifact.artifactId` with `append: true`;
 * `lastChunk: true` seals the artifact. Both default to false.
 */
const A2AProtocolTaskArtifactUpdateEventSchema = z.object({
  taskId: z.string(),
  contextId: z.string(),
  artifact: A2AProtocolArtifactSchema,
  append: z.boolean().optional(),
  lastChunk: z.boolean().optional(),
  metadata: z.any().optional(),
});
export type A2AProtocolTaskArtifactUpdateEvent = z.infer<
  typeof A2AProtocolTaskArtifactUpdateEventSchema
>;

/**
 * A single event in a SendStreamingMessage / SubscribeToTask stream. Exactly
 * one field is set per event: `statusUpdate` for incremental working/terminal
 * state (carrying partial text), `artifactUpdate` for an artifact chunk,
 * `message` for a complete agent message, or `task` for a full task snapshot
 * (the first frame of a v1.0 lifecycle stream, or an approval-required task at
 * the end of a legacy stream). Field naming mirrors the non-streaming
 * SendMessage response (`message`/`task`) so clients parse both shapes the
 * same way.
 */
export const A2AProtocolStreamResponseSchema = z.object({
  statusUpdate: A2AProtocolTaskStatusUpdateEventSchema.optional(),
  artifactUpdate: A2AProtocolTaskArtifactUpdateEventSchema.optional(),
  message: A2AProtocolMessageSchema.optional(),
  task: A2AProtocolTaskSchema.optional(),
});
export type A2AProtocolStreamResponse = z.infer<
  typeof A2AProtocolStreamResponseSchema
>;
