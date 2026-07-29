/**
 * GitHub Copilot API schemas - OpenAI-compatible
 *
 * GitHub Copilot's chat completions API (https://api.githubcopilot.com) is
 * OpenAI-compatible. We reuse OpenAI schemas and use .passthrough() on
 * request/response to allow Copilot-specific fields.
 *
 * @see https://docs.github.com/en/copilot
 */

import { z } from "zod";
import {
  ChatCompletionsHeadersSchema,
  ChatCompletionUsageSchema,
  FinishReasonSchema,
  ChatCompletionRequestSchema as OpenAIChatCompletionRequestSchema,
  ChatCompletionResponseSchema as OpenAIChatCompletionResponseSchema,
} from "../openai/api";

// Re-export headers and other schemas from OpenAI
export {
  ChatCompletionsHeadersSchema,
  ChatCompletionUsageSchema,
  FinishReasonSchema,
};

/**
 * Copilot's rejection of a model its `/chat/completions` endpoint does not
 * serve — returned even for models `/models` catalogues. The code appears on
 * direct upstream responses; the message is what survives the LLM proxy's
 * error wrapping (the proxy keeps `message`/`type` but drops `code`).
 */
export const MODEL_NOT_SUPPORTED_CODE = "model_not_supported";
export const MODEL_NOT_SUPPORTED_MESSAGE =
  "The requested model is not supported.";

/** Request schema with passthrough for Copilot-specific params. */
export const ChatCompletionRequestSchema =
  OpenAIChatCompletionRequestSchema.passthrough();

/**
 * Response schema with passthrough for Copilot-specific fields. Copilot's
 * responses are OpenAI-shaped but non-standard: a non-streaming completion can
 * omit the top-level `created` and `object` fields (and `object` isn't always
 * the literal "chat.completion"). Relax both so response serialization doesn't
 * 500 — clients still receive Copilot's actual fields via passthrough.
 */
export const ChatCompletionResponseSchema =
  OpenAIChatCompletionResponseSchema.extend({
    created: z.number().optional(),
    object: z.string().optional(),
  }).passthrough();
