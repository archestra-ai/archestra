/**
 * OpenRouter API schemas
 *
 * OpenRouter uses an OpenAI-compatible API at https://openrouter.ai/api/v1
 * Full tool calling support, streaming, and standard OpenAI message format.
 *
 * @see https://openrouter.ai/docs/api-reference/overview
 */

import { z } from "zod";
import {
  ChatCompletionsHeadersSchema,
  ChatCompletionUsageSchema,
  FinishReasonSchema,
  ChatCompletionRequestSchema as OpenAIChatCompletionRequestSchema,
  ChatCompletionResponseSchema as OpenAIChatCompletionResponseSchema,
} from "../openai/api";

export {
  ChatCompletionsHeadersSchema,
  ChatCompletionUsageSchema,
  FinishReasonSchema,
};

/**
 * OpenRouter `response_format`. `.passthrough()` preserves the nested
 * `json_schema` body (name/schema/strict) that OpenRouter requires — a
 * `{ type }`-only model would silently drop it.
 *
 * @see https://openrouter.ai/docs/guides/features/structured-outputs
 */
const ResponseFormatSchema = z
  .object({
    type: z.enum(["text", "json_object", "json_schema"]),
  })
  .passthrough();

// `response_format` must be declared so inbound validation forwards it to
// OpenRouter (the OpenAI base schema strips undeclared fields). `plugins` is
// intentionally NOT declared — response-healing is injected server-side, and
// admitting it would let callers route arbitrary OpenRouter plugins.
export const ChatCompletionRequestSchema =
  OpenAIChatCompletionRequestSchema.extend({
    response_format: ResponseFormatSchema.optional(),
  });

export const ChatCompletionResponseSchema =
  OpenAIChatCompletionResponseSchema.passthrough();
