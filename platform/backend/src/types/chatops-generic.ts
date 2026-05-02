import { z } from "zod";

const GenericA2AAttachmentSchema = z.object({
  contentType: z.string().min(1).max(256),
  contentBase64: z.string().min(1),
  name: z.string().max(256).optional(),
});
export type GenericA2AAttachment = z.infer<typeof GenericA2AAttachmentSchema>;

const GenericSenderSchema = z.object({
  externalId: z.string().min(1).max(256),
  email: z.string().email().max(256).optional(),
  name: z.string().min(1).max(256),
});
export type GenericSender = z.infer<typeof GenericSenderSchema>;

const GenericChannelSchema = z.object({
  externalId: z.string().min(1).max(256),
  name: z.string().max(256).nullable().optional(),
  kind: z.enum(["dm", "channel", "group"]),
});
export type GenericChannel = z.infer<typeof GenericChannelSchema>;

const GenericWorkspaceSchema = z.object({
  externalId: z.string().min(1).max(256),
  name: z.string().max(256).nullable().optional(),
});
export type GenericWorkspace = z.infer<typeof GenericWorkspaceSchema>;

const GenericThreadSchema = z.object({
  externalId: z.string().min(1).max(256),
});
export type GenericThread = z.infer<typeof GenericThreadSchema>;

const GenericHistoryFileRefSchema = z.object({
  fileId: z.string().min(1).max(256),
  mimeType: z.string().min(1).max(256),
  name: z.string().max(256).optional(),
  size: z.number().int().nonnegative().optional(),
});
export type GenericHistoryFileRef = z.infer<typeof GenericHistoryFileRefSchema>;

const GenericHistoryMessageSchema = z.object({
  messageId: z.string().min(1).max(256),
  senderId: z.string().min(1).max(256),
  senderName: z.string().min(1).max(256),
  text: z.string(),
  timestamp: z.string().datetime(),
  isFromBot: z.boolean(),
  files: z.array(GenericHistoryFileRefSchema).max(20).default([]),
});
export type GenericHistoryMessage = z.infer<typeof GenericHistoryMessageSchema>;

const GenericAgentOptionSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(256),
});
export type GenericAgentOption = z.infer<typeof GenericAgentOptionSchema>;

export const GenericMessageEventRequestSchema = z
  .object({
    schemaVersion: z.literal("v1"),
    messageId: z.string().min(1).max(256),
    sender: GenericSenderSchema,
    channel: GenericChannelSchema,
    workspace: GenericWorkspaceSchema.nullable().optional(),
    thread: GenericThreadSchema.nullable().optional(),
    text: z.string(),
    rawText: z.string(),
    timestamp: z.string().datetime(),
    isThreadReply: z.boolean(),
    replyContext: z.unknown(),
    attachments: z.array(GenericA2AAttachmentSchema).max(20).default([]),
    threadHistory: z.array(GenericHistoryMessageSchema).max(50).default([]),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();
export type GenericMessageEventRequest = z.infer<
  typeof GenericMessageEventRequestSchema
>;

export const GenericInteractiveEventRequestSchema = z
  .object({
    schemaVersion: z.literal("v1"),
    eventId: z.string().min(1).max(256),
    action: z.literal("select-agent"),
    agentId: z.string().uuid(),
    sender: GenericSenderSchema,
    channel: GenericChannelSchema,
    workspace: GenericWorkspaceSchema.nullable().optional(),
    thread: GenericThreadSchema.nullable().optional(),
    timestamp: z.string().datetime(),
    replyContext: z.unknown(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();
export type GenericInteractiveEventRequest = z.infer<
  typeof GenericInteractiveEventRequestSchema
>;

export const GenericCommandEventRequestSchema = z
  .object({
    schemaVersion: z.literal("v1"),
    eventId: z.string().min(1).max(256),
    command: z.enum(["help", "status", "select-agent"]),
    rawCommand: z.string().max(128).optional(),
    text: z.string().default(""),
    sender: GenericSenderSchema,
    channel: GenericChannelSchema,
    workspace: GenericWorkspaceSchema.nullable().optional(),
    thread: GenericThreadSchema.nullable().optional(),
    timestamp: z.string().datetime(),
    replyContext: z.unknown(),
    threadHistory: z.array(GenericHistoryMessageSchema).max(50).default([]),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();
export type GenericCommandEventRequest = z.infer<
  typeof GenericCommandEventRequestSchema
>;

const GenericChannelSyncEntrySchema = z
  .object({
    externalId: z.string().min(1).max(256),
    name: z.string().max(256).nullable().optional(),
    kind: z.enum(["dm", "channel", "group"]),
    dmOwnerEmail: z.string().email().max(256).nullable().optional(),
  })
  .strict();

export const GenericChannelSyncRequestSchema = z
  .object({
    schemaVersion: z.literal("v1"),
    syncMode: z.literal("full"),
    workspace: GenericWorkspaceSchema,
    channels: z.array(GenericChannelSyncEntrySchema).max(5000),
  })
  .strict();
export type GenericChannelSyncRequest = z.infer<
  typeof GenericChannelSyncRequestSchema
>;

export const GenericSendReplyCallbackSchema = z
  .object({
    schemaVersion: z.literal("v1"),
    deliveryId: z.string().min(1).max(128),
    replyContext: z.unknown(),
    text: z.string(),
    footer: z.string().max(512).optional(),
    metadata: z
      .object({
        approvalRequest: z
          .object({
            taskId: z.string().min(1),
            approvalId: z.string().min(1),
            toolName: z.string().min(1),
          })
          .optional(),
      })
      .optional(),
  })
  .strict();
export type GenericSendReplyCallback = z.infer<
  typeof GenericSendReplyCallbackSchema
>;

export const GenericAgentSelectionCallbackSchema = z
  .object({
    schemaVersion: z.literal("v1"),
    deliveryId: z.string().min(1).max(128),
    replyContext: z.unknown(),
    isWelcome: z.boolean(),
    text: z.string().optional(),
    agents: z.array(GenericAgentOptionSchema).min(1).max(200),
  })
  .strict();
export type GenericAgentSelectionCallback = z.infer<
  typeof GenericAgentSelectionCallbackSchema
>;

export const GenericTypingCallbackSchema = z
  .object({
    schemaVersion: z.literal("v1"),
    deliveryId: z.string().min(1).max(128),
    replyContext: z.unknown(),
  })
  .strict();
export type GenericTypingCallback = z.infer<typeof GenericTypingCallbackSchema>;
