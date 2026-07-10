/**
 * Microsoft 365 Copilot API schemas - OpenAI-compatible inbound wire format
 *
 * The proxy exposes Microsoft 365 Copilot as an OpenAI-compatible chat completions
 * surface; the adapter translates to the Microsoft 365 Copilot Chat API
 * (Microsoft Graph beta) upstream. We reuse OpenAI schemas and use
 * .passthrough() on request/response for forward compatibility.
 *
 * @see https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/api/ai-services/chat/overview
 */

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

/** Request schema with passthrough for provider-specific params. */
export const ChatCompletionRequestSchema =
  OpenAIChatCompletionRequestSchema.passthrough();

/**
 * Response schema with passthrough. Responses are produced by our own Graph
 * translation, so they are fully OpenAI-shaped; passthrough keeps any extra
 * fields (e.g. future citation surfacing) from being stripped.
 */
export const ChatCompletionResponseSchema =
  OpenAIChatCompletionResponseSchema.passthrough();
