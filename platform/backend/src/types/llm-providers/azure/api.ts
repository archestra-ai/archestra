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
export {
  ImageEditFieldsSchema,
  ImageGenerationRequestSchema,
} from "./image-parameters";

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
