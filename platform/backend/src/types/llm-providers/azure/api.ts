/**
 * Azure AI Foundry API schemas
 *
 * Azure AI Foundry provides an OpenAI-compatible API at your deployment endpoint.
 * Full tool calling support, streaming, and standard OpenAI message format.
 *
 * @see https://learn.microsoft.com/en-us/azure/ai-foundry/openai/api-reference
 */

import { z } from "zod";
import {
  ChatCompletionRequestSchema,
  ChatCompletionUsageSchema,
  FinishReasonSchema,
  ChatCompletionResponseSchema as OpenAIChatCompletionResponseSchema,
  ResponsesRequestSchema,
  ResponsesResponseSchema,
  ResponsesUsageSchema,
} from "../openai/api";

export {
  ChatCompletionRequestSchema,
  ChatCompletionUsageSchema,
  FinishReasonSchema,
  ResponsesRequestSchema,
  ResponsesResponseSchema,
  ResponsesUsageSchema,
};

export const ChatCompletionsHeadersSchema = z.object({
  "api-key": z
    .string()
    .optional()
    .describe("Archestra virtual API key for native Azure SDK clients"),
  "user-agent": z.string().optional().describe("The user agent of the client"),
  authorization: z
    .string()
    .optional()
    .describe("Bearer token for Azure AI Foundry")
    .transform((authorization) =>
      authorization ? authorization.replace("Bearer ", "") : undefined,
    ),
});

export const ChatCompletionResponseSchema =
  OpenAIChatCompletionResponseSchema.passthrough();

/** Native image generation. Chat streams the completed artifact to the UI. */
export const ImageGenerationRequestSchema = z.object({
  model: z.string().min(1),
  prompt: z.string().min(1),
  n: z.number().int().min(1).max(10).optional(),
  size: z.enum(["auto", "1024x1024", "1536x1024", "1024x1536"]).optional(),
  quality: z.enum(["auto", "low", "medium", "high"]).optional(),
  background: z.enum(["auto", "transparent", "opaque"]).optional(),
  output_format: z.enum(["png", "jpeg", "webp"]).optional(),
  output_compression: z.number().int().min(0).max(100).optional(),
  moderation: z.enum(["auto", "low"]).optional(),
  user: z.string().optional(),
  stream: z.literal(false).optional(),
});

export const ImageGenerationResponseSchema = z
  .object({
    created: z.number(),
    model: z.string().optional(),
    data: z
      .array(
        z.object({
          b64_json: z.string().optional(),
          url: z.string().optional(),
          revised_prompt: z.string().optional(),
        }),
      )
      .optional(),
    usage: z
      .object({
        input_tokens: z.number(),
        output_tokens: z.number(),
        total_tokens: z.number(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

/** Finite media turns; the backend uses native Realtime WebSockets upstream. */
export const RealtimeTurnRequestSchema = ChatCompletionRequestSchema.extend({
  target_language: z
    .string()
    .regex(/^[a-z]{2,3}(?:-[A-Za-z]{2,8})?$/)
    .optional(),
}).describe(
  "A bounded realtime audio turn. Translation requires WAV input and target_language; tools are not supported.",
);
