/**
 * Perplexity API schemas — both of the provider's surfaces.
 *
 * Chat completions (the `sonar*` models) is OpenAI-compatible with some
 * differences:
 * - It takes no `tools`/`tool_choice` — it answers `invalid request` when they
 *   are sent (see inferPerplexityCapabilities in services/model-sync.ts)
 * - Has search_results field in responses (citations from web search)
 * - Has Perplexity-specific usage fields (search_context_size, citation_tokens, etc.)
 *
 * The Agent API (the vendor-prefixed models) is Responses-shaped and
 * OpenAI-compatible: served at `POST /v1/agent`, with `POST /v1/responses` as
 * the alias the OpenAI SDKs target. It takes an `input` rather than `messages`
 * and answers with a typed `output` array — and it is the only Perplexity
 * surface that accepts `tools`.
 *
 * The OpenAI Responses schemas are reused rather than restated, because the
 * shapes that matter here are identical: custom functions are declared flat as
 * `{ type: "function", name, parameters }`, calls come back as
 * `{ type: "function_call", call_id, name, arguments }`, and results go back as
 * `{ type: "function_call_output", call_id, output }`. Both schemas also pass
 * through unknown fields, which is what lets the Agent API's own request fields
 * (`preset`, `max_steps`, `models`) and its extra output items
 * (`search_results`, `sandbox_results`, `mcp_call`, …) survive a round trip
 * untouched instead of needing a schema arm each.
 *
 * @see https://docs.perplexity.ai/api-reference/chat-completions-post
 * @see https://docs.perplexity.ai/api-reference/agent-post
 * @see https://docs.perplexity.ai/docs/agent-api/tools/custom-functions
 */

import { z } from "zod";
import {
  ChatCompletionsHeadersSchema,
  ChatCompletionUsageSchema,
  FinishReasonSchema,
  ChatCompletionRequestSchema as OpenAIChatCompletionRequestSchema,
  ChatCompletionResponseSchema as OpenAIChatCompletionResponseSchema,
  ResponsesRequestSchema,
  ResponsesResponseSchema,
  ResponsesUsageSchema,
} from "../openai/api";

// Re-export the schemas Perplexity shares verbatim with OpenAI
export {
  ChatCompletionsHeadersSchema,
  ChatCompletionUsageSchema,
  FinishReasonSchema,
  ResponsesRequestSchema,
  ResponsesResponseSchema,
  ResponsesUsageSchema,
};

export const ResponsesHeadersSchema = z.object({
  "user-agent": z.string().optional().describe("The user agent of the client"),
  authorization: z
    .string()
    .optional()
    .describe("Bearer token for the Perplexity Agent API")
    .transform((authorization) =>
      authorization ? authorization.replace("Bearer ", "") : undefined,
    ),
});

/**
 * Perplexity's streaming format selector.
 *
 * `full` (the API default) streams complete message objects and emits no
 * reasoning. `concise` streams deltas only and adds the `chat.reasoning` /
 * `chat.reasoning.done` chunks that carry the model's chain of thought — the
 * only way to obtain reasoning from the chat-completions endpoint.
 *
 * @see https://docs.perplexity.ai/docs/sonar/pro-search/stream-mode
 */
export const StreamModeSchema = z.enum(["full", "concise"]);

/**
 * Perplexity request schema: OpenAI-compatible plus `stream_mode`.
 */
export const ChatCompletionRequestSchema =
  OpenAIChatCompletionRequestSchema.extend({
    stream_mode: StreamModeSchema.optional(),
  });

/**
 * Perplexity response schema with passthrough for extra fields.
 * Perplexity API returns additional fields like "citations" and "search_results"
 * that are not in the standard OpenAI schema.
 */
export const ChatCompletionResponseSchema =
  OpenAIChatCompletionResponseSchema.passthrough();
