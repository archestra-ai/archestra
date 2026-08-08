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
  ResponsesRequestSchema as OpenAIResponsesRequestSchema,
  ResponsesResponseSchema as OpenAIResponsesResponseSchema,
  ResponsesUsageSchema,
} from "../openai/api";

// Re-export headers and other schemas from OpenAI
export {
  ChatCompletionsHeadersSchema,
  ChatCompletionUsageSchema,
  FinishReasonSchema,
  ResponsesUsageSchema,
};

/**
 * The Responses surface authenticates identically to chat completions — the
 * incoming credential is the same long-lived GitHub OAuth token, which the
 * adapter's fetch wrapper exchanges for a short-lived Copilot bearer. So the
 * chat header schema (which strips the `Bearer ` prefix) serves both surfaces,
 * matching how Azure shares one header schema across its two surfaces.
 */
export { ChatCompletionsHeadersSchema as ResponsesHeadersSchema };

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

/**
 * Copilot's second surface: `POST /responses`. Its Codex and GPT-5.x models
 * declare `supported_endpoints: ["/responses"]` and reject `/chat/completions`
 * outright, so this is the only way to reach them.
 *
 * Request passes through unchanged — the wire format is OpenAI's Responses API.
 */
export const ResponsesRequestSchema =
  OpenAIResponsesRequestSchema.passthrough();

/**
 * Response schema relaxed the same way (and for the same reason) as
 * `ChatCompletionResponseSchema` above: Copilot's payloads are OpenAI-shaped
 * but it does not guarantee every envelope field OpenAI does. Requiring the
 * literal `object: "response"` plus `created_at`/`status` would turn any such
 * omission into a 500 during response serialization, hiding an otherwise
 * perfectly usable completion. Clients still receive Copilot's real fields via
 * passthrough.
 */
export const ResponsesResponseSchema = OpenAIResponsesResponseSchema.extend({
  object: z.string().optional(),
  created_at: z.number().optional(),
  status: z.string().optional(),
}).passthrough();
