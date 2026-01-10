import { z } from "zod";
import { ToolCallSchema, ToolResultSchema } from "./tools";

/**
 * Cohere message roles
 */
const RoleSchema = z.enum(["user", "assistant", "system", "tool"]);

/**
 * Text content block
 */
const TextContentBlockSchema = z.object({
  type: z.literal("text"),
  text: z.string(),
});

/**
 * Image content block (for multimodal)
 */
const ImageContentBlockSchema = z.object({
  type: z.literal("image_url"),
  image_url: z.object({
    url: z.string(),
  }),
});

/**
 * Document content block
 */
const DocumentContentBlockSchema = z.object({
  type: z.literal("document"),
  document: z.object({
    id: z.string().optional(),
    data: z.record(z.string(), z.unknown()),
  }),
});

/**
 * Content block union for response
 */
export const MessageContentBlockSchema = z.union([
  TextContentBlockSchema,
]);

/**
 * User message format
 */
const UserMessageSchema = z.object({
  role: z.literal("user"),
  content: z.union([
    z.string(),
    z.array(z.union([TextContentBlockSchema, ImageContentBlockSchema, DocumentContentBlockSchema])),
  ]),
});

/**
 * System message format
 */
const SystemMessageSchema = z.object({
  role: z.literal("system"),
  content: z.string(),
});

/**
 * Assistant message format
 */
const AssistantMessageSchema = z.object({
  role: z.literal("assistant"),
  content: z.union([
    z.string(),
    z.array(TextContentBlockSchema),
  ]).optional(),
  tool_calls: z.array(ToolCallSchema).optional(),
  tool_plan: z.string().optional(),
});

/**
 * Tool message format (tool results)
 */
const ToolMessageSchema = z.object({
  role: z.literal("tool"),
  tool_call_id: z.string(),
  content: z.union([
    z.string(),
    z.array(z.union([TextContentBlockSchema, DocumentContentBlockSchema])),
  ]),
});

/**
 * All message types for request
 */
export const MessageParamSchema = z.union([
  UserMessageSchema,
  SystemMessageSchema,
  AssistantMessageSchema,
  ToolMessageSchema,
]);
