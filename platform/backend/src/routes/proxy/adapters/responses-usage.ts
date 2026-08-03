/**
 * Token usage for the OpenAI Responses transport, in both directions.
 *
 * Reading (`fromResponsesUsage`): the wire's `input_tokens` is the GROSS prompt
 * count with cache reads counted inside it, while `UsageView.inputTokens` is
 * defined as uncached input only. The cache read has to be split back out, or
 * every cached token is priced at the full input rate and `cacheReadTokens`
 * stays zero so the provider's read discount is never applied.
 *
 * Writing (`toResponsesUsage`): the reverse — the split has to be re-added, so
 * the client reads the same prompt count its provider reported.
 *
 * A synthesized terminal `response.completed` — the frame the client gets when
 * the proxy replaces the turn (tool-invocation refusal, dual-LLM fail-closed)
 * rather than relaying upstream's own — must always carry a numeric usage
 * object. The Responses parser validates every chunk against a discriminated
 * union whose `response.completed` arm requires `usage.input_tokens` and
 * `usage.output_tokens` as numbers (`input_tokens_details` /
 * `output_tokens_details` are nullish, so they may be omitted). A frame without
 * them does not fail parsing: it matches the union's permissive unknown-chunk
 * fallback and is dropped, the "response finished" test never fires, and the
 * turn ends with no tokens and a default finish reason — the same silent-drop
 * trap documented in responses-stream-error-frame.ts.
 *
 * So `toResponsesUsage` returns zeros rather than `undefined` for an unobserved
 * turn: zero is a wire value the client can read, absence is not.
 */
import type { UsageView } from "@/types";

/** A `usage` object as the Responses wire shape reports it. */
export interface ResponsesWireUsage {
  input_tokens?: number;
  input_tokens_details?: { cached_tokens?: number } | null;
  output_tokens?: number;
  output_tokens_details?: { reasoning_tokens?: number } | null;
}

export interface ResponsesUsage {
  input_tokens: number;
  input_tokens_details: { cached_tokens: number };
  output_tokens: number;
  output_tokens_details: { reasoning_tokens: number };
  total_tokens: number;
}

/** Read a Responses usage object into the accumulator's normalized view. */
export function fromResponsesUsage(
  usage: ResponsesWireUsage | null | undefined,
): UsageView {
  const { input, output, cacheRead, reasoning } = responsesUsageTokens(usage);
  return {
    inputTokens: input,
    outputTokens: output,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: 0,
    reasoningTokens: reasoning,
  };
}

/**
 * The same split in the shape the fetch-based metrics wrapper consumes.
 *
 * This cannot borrow the chat-completions extractor: that one reads
 * `prompt_tokens`/`completion_tokens`, which a Responses body does not carry,
 * so it subtracts from `undefined` and yields NaN — and because the reporter
 * skips falsy counts, the turn's tokens are then dropped from the metric
 * entirely rather than reported wrong.
 */
export function responsesUsageTokens(
  usage: ResponsesWireUsage | null | undefined,
) {
  const cacheRead = usage?.input_tokens_details?.cached_tokens ?? 0;
  return {
    input: Math.max(0, (usage?.input_tokens ?? 0) - cacheRead),
    output: usage?.output_tokens ?? 0,
    cacheRead,
    cacheWrite: 0,
    reasoning: usage?.output_tokens_details?.reasoning_tokens ?? 0,
  };
}

/** Map the accumulator's usage back onto the Responses wire fields. */
export function toResponsesUsage(
  usage: UsageView | null | undefined,
): ResponsesUsage {
  const cachedTokens = usage?.cacheReadTokens ?? 0;
  // Back to the gross prompt count the provider reported, so a turn the proxy
  // replaced reports the same input as the turn it replaced.
  const inputTokens = (usage?.inputTokens ?? 0) + cachedTokens;
  const outputTokens = usage?.outputTokens ?? 0;
  return {
    input_tokens: inputTokens,
    input_tokens_details: { cached_tokens: cachedTokens },
    output_tokens: outputTokens,
    output_tokens_details: { reasoning_tokens: usage?.reasoningTokens ?? 0 },
    total_tokens: inputTokens + outputTokens,
  };
}
