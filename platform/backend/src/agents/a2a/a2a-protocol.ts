import z from "zod";

/**
 * Types and schemas for the A2A Protocol.
 * Types and schemas with name starting with "A2AArchestra"
 *   are for Archestra A2A Protocol extensions in metadata.
 */

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

const A2AProtocolArtifactSchema = z.object({});

export enum A2AProtocolTaskState {
  Unspecified = "TASK_STATE_UNSPECIFIED",
  Submitted = "TASK_STATE_SUBMITTED",
  Working = "TASK_STATE_WORKING",
  Completed = "TASK_STATE_COMPLETED",
  Failed = "TASK_STATE_FAILED",
  Canceled = "TASK_STATE_CANCELED",
  InputRequired = "TASK_STATE_INPUT_REQUIRED",
  Rejected = "TASK_STATE_REJECTED",
  AuthRequired = "TASK_STATE_AUTH_REQUIRED",
}

const A2AProtocolTaskStatusSchema = z.object({
  state: z.enum(A2AProtocolTaskState),
  message: A2AProtocolMessageSchema.optional(),
  timestamp: z.number().optional(),
});

export const A2AProtocolTaskSchema = z.object({
  id: z.string(),
  contextId: z.string().optional(),
  status: A2AProtocolTaskStatusSchema,
  artifacts: z.array(A2AProtocolArtifactSchema).optional(),
  history: z.array(A2AProtocolMessageSchema).optional(),
  metadata: A2AArchestraTaskMetadataSchema.optional(),
});
export type A2AProtocolTask = z.infer<typeof A2AProtocolTaskSchema>;

export const A2AProtocolGetTaskRequestSchema = z.object({
  tenant: z.string().optional(),
  id: z.string(),
  historyLength: z.number().optional(),
});
export type A2AProtocolGetTaskRequest = z.infer<
  typeof A2AProtocolGetTaskRequestSchema
>;

// --- A2A Send Message ---

const A2AProtocolSendMessageConfigurationSchema = z.object({});

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
