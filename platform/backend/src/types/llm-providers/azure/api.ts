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
