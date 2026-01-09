import { z } from "zod";

/**
 * Text content block
 */
export const CohereTextContentSchema = z.object({
  type: z.literal("text"),
  text: z.string(),
});

/**
 * Tool call definition in assistant response
 */
export const CohereToolCallSchema = z.object({
  id: z.string(),
  type: z.literal("function"),
  function: z.object({
    name: z.string(),
    arguments: z.string(),
  }),
});

/**
 * Union of message content types
 */
export const CohereMessageContentBlockSchema = z.union([
  CohereTextContentSchema,
  z.object({
    type: z.literal("tool_result"),
    tool_call_id: z.string(),
    content: z.string(),
  }),
]);

/**
 * User message
 */
export const CohereUserMessageSchema = z.object({
  role: z.literal("user"),
  content: z.union([z.string(), z.array(CohereMessageContentBlockSchema)]),
});

/**
 * Assistant message
 */
export const CohereAssistantMessageSchema = z.object({
  role: z.literal("assistant"),
  content: z
    .union([z.string(), z.array(CohereMessageContentBlockSchema)])
    .optional(),
  tool_calls: z.array(CohereToolCallSchema).optional(),
});

/**
 * System message
 */
export const CohereSystemMessageSchema = z.object({
  role: z.literal("system"),
  content: z.string(),
});

/**
 * Tool message (tool result response)
 */
export const CohereToolMessageSchema = z.object({
  role: z.literal("tool"),
  tool_call_id: z.string(),
  content: z.string(),
});

/**
 * Union of all message types
 */
export const CohereMessageParamSchema = z.union([
  CohereUserMessageSchema,
  CohereAssistantMessageSchema,
  CohereSystemMessageSchema,
  CohereToolMessageSchema,
]);
