/**
 * Shared encoder for the OpenAI chat-completions streaming wire shape.
 *
 * Several adapters translate a non-OpenAI provider into this shape
 * (anthropic-openai, cohere-openai, gemini-openai) and each carried a private,
 * byte-identical copy of the envelope. The copies drifted: none of them ever
 * emitted `usage`, so a client streaming through those surfaces never learned
 * its token counts even though the accumulator had them. One definition keeps
 * that from happening again.
 */
import type { UsageView } from "@/types";

/** Token counts in the OpenAI chat-completions wire shape. */
export interface OpenAiStreamUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  /**
   * OpenAI reports prompt-cache hits as a subset of `prompt_tokens`. Providers
   * that count cache reads separately (Anthropic, Bedrock, Gemini) must publish
   * them here, or the gross `prompt_tokens` above is indistinguishable from an
   * uncached prompt of the same size — and a consumer that recovers the split
   * the way this codebase does (`prompt_tokens - cached_tokens`, see the openai
   * adapter's `getUsageTokens`) attributes the whole prompt to full-price input.
   */
  prompt_tokens_details?: { cached_tokens: number };
}

/**
 * Map the internal accumulator's usage onto the OpenAI wire fields, or
 * `undefined` when the provider never reported any.
 *
 * Valid only where `UsageView.inputTokens` already equals the provider's gross
 * prompt count. It is NOT universal, and the exceptions are the rule for every
 * cache-aware provider: `inputTokens` is normalized to *uncached* input, so an
 * adapter whose provider reports cache tokens outside its input count
 * (anthropic, bedrock, gemini) must map its own numbers instead — otherwise a
 * heavily cached turn reports only the handful of tokens that missed the cache
 * as its entire prompt.
 */
export function toOpenAiStreamUsage(
  usage: UsageView | null | undefined,
): OpenAiStreamUsage | undefined {
  if (!usage) {
    return undefined;
  }
  return {
    prompt_tokens: usage.inputTokens,
    completion_tokens: usage.outputTokens,
    total_tokens: usage.inputTokens + usage.outputTokens,
  };
}

/**
 * Format one `chat.completion.chunk` SSE event.
 *
 * `usage` is already mapped to the wire shape (via `toOpenAiStreamUsage`, or by
 * the caller when its provider needs different arithmetic) and is omitted
 * unless supplied, because it belongs only on the final chunk — a delta chunk
 * carrying usage would be a protocol error.
 */
export function formatOpenAiChunkSse(params: {
  id: string;
  created: number;
  model: string;
  delta: Record<string, unknown>;
  finishReason: string | null;
  usage?: OpenAiStreamUsage;
}): string {
  return `data: ${JSON.stringify({
    id: params.id,
    object: "chat.completion.chunk",
    created: params.created,
    model: params.model,
    choices: [
      {
        index: 0,
        delta: params.delta,
        finish_reason: params.finishReason,
        logprobs: null,
      },
    ],
    ...(params.usage ? { usage: params.usage } : {}),
  })}\n\n`;
}
