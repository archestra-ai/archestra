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

// Cohere reasoning models return `thinking` content blocks alongside text,
// and clients replay them in assistant history on later turns.
// https://docs.cohere.com/docs/thinking
const CohereThinkingContentSchema = z.object({
  type: z.literal("thinking"),
  thinking: z.string(),
});

// Upstream grows new content block types over time (thinking arrived with the
// reasoning models). An unrecognized block must not fail request validation
// (400) or response serialization (500) of a relay — mirror the open
// finish_reason enum in api.ts. Known block shapes above match first; this
// fallback only admits objects that at least carry a `type` discriminator.
const CohereUnknownContentBlockSchema = z
  .object({ type: z.string() })
  .passthrough();

export const CohereMessageContentBlockSchema = z.union([
  CohereTextContentSchema,
  z.object({
    type: z.literal("tool_result"),
    tool_call_id: z.string(),
    content: z.string(),
  }),
  CohereThinkingContentSchema,
  CohereUnknownContentBlockSchema,
]);

// Cohere v2 user messages accept image content blocks; `url` may be a base64
// data URI or a web URL. https://docs.cohere.com/reference/chat
export const CohereImageUrlContentSchema = z.object({
  type: z.literal("image_url"),
  image_url: z.object({
    url: z.string(),
    detail: z.enum(["auto", "low", "high"]).optional(),
  }),
});

const CohereUserContentBlockSchema = z.union([
  CohereTextContentSchema,
  CohereImageUrlContentSchema,
]);

export const CohereUserMessageSchema = z.object({
  role: z.literal("user"),
  content: z.union([z.string(), z.array(CohereUserContentBlockSchema)]),
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
