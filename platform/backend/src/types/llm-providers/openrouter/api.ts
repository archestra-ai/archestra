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

/**
 * OpenRouter request-level plugin, e.g. `{ id: "response-healing" }`.
 * `.passthrough()` preserves any per-plugin configuration.
 *
 * @see https://openrouter.ai/docs/guides/features/plugins
 */
const PluginSchema = z.object({ id: z.string() }).passthrough();

/**
 * OpenRouter is OpenAI-compatible but additionally accepts `response_format`
 * and `plugins`. These MUST be declared here: the OpenAI base schema is a plain
 * `z.object`, so inbound Zod validation strips any field it doesn't declare
 * before the request reaches OpenRouter.
 */
export const ChatCompletionRequestSchema =
  OpenAIChatCompletionRequestSchema.extend({
    response_format: ResponseFormatSchema.optional(),
    plugins: z.array(PluginSchema).optional(),
  });

export const ChatCompletionResponseSchema =
  OpenAIChatCompletionResponseSchema.passthrough();
