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
}

/**
 * Map the internal accumulator's usage onto the OpenAI wire fields, or
 * `undefined` when the provider never reported any.
 *
 * Valid only where `UsageView.inputTokens` already equals the provider's gross
 * prompt count. It is NOT universal: `inputTokens` is normalized to *uncached*
 * input, so any adapter whose accumulator subtracts cache reads (gemini) must
 * map its own numbers instead, or the stream would report a smaller prompt than
 * the non-streaming reply for the identical turn.
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
