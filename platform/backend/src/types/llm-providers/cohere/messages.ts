import { z } from "zod";
export const CohereTextContentSchema = z.object({
  type: z.literal("text"),
  text: z.string(),
});
export const CohereToolCallSchema = z.object({
  id: z.string(),
  type: z.literal("function"),
  function: z.object({
    name: z.string(),
    arguments: z.string(),
  }),
});

export const CohereMessageContentBlockSchema = z.union([
  CohereTextContentSchema,
  z.object({
    type: z.literal("tool_result"),
    tool_call_id: z.string(),
    content: z.string(),
  }),
]);

export const CohereUserMessageSchema = z.object({
  role: z.literal("user"),
  content: z.union([z.string(), z.array(CohereMessageContentBlockSchema)]),
});

export const CohereAssistantMessageSchema = z.object({
  role: z.literal("assistant"),
  content: z
    .union([z.string(), z.array(CohereMessageContentBlockSchema)])
    .optional(),
  tool_calls: z.array(CohereToolCallSchema).optional(),
});

export const CohereSystemMessageSchema = z.object({
  role: z.literal("system"),
  content: z.string(),
});

export const CohereToolMessageSchema = z.object({
  role: z.literal("tool"),
  tool_call_id: z.string(),
  content: z.string(),
});

export const CohereMessageParamSchema = z.union([
  CohereUserMessageSchema,
  CohereAssistantMessageSchema,
  CohereSystemMessageSchema,
  CohereToolMessageSchema,
]);
