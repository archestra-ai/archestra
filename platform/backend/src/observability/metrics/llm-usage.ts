/**
 * The token usage of each provider's response, as the LLM metrics and the
 * proxy's adapters read it. It lives below both, so the metrics need no adapter
 * and the core layer no proxy route.
 */
import type { SupportedProvider } from "@archestra/shared";
import type { Anthropic, Cohere, Minimax, OpenAi, Zhipuai } from "@/types";

export function anthropicUsageTokens(usage: Anthropic.Types.Usage) {
  return {
    input: usage.input_tokens,
    output: usage.output_tokens,
    cacheRead: usage.cache_read_input_tokens ?? 0,
    cacheWrite: usage.cache_creation_input_tokens ?? 0,
    cacheWrite1h: usage.cache_creation?.ephemeral_1h_input_tokens ?? 0,
  };
}

export function cohereUsageTokens(usage: Cohere.Types.Usage | undefined) {
  return {
    input:
      usage?.tokens?.input_tokens ?? usage?.billed_units?.input_tokens ?? 0,
    output:
      usage?.tokens?.output_tokens ?? usage?.billed_units?.output_tokens ?? 0,
  };
}

export function geminiUsageTokens(usage: {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  cachedContentTokenCount?: number;
  thoughtsTokenCount?: number;
  toolUsePromptTokenCount?: number;
}) {
  // Gemini's cachedContentTokenCount is a SUBSET already inside promptTokenCount,
  // so subtract it to get the uncached input and avoid double-counting.
  const cacheRead = usage.cachedContentTokenCount ?? 0;
  // Thinking tokens are reported beside candidatesTokenCount, not inside it,
  // and are billed as output. Fold them in so output includes reasoning, as
  // it does for every other provider.
  const reasoning = usage.thoughtsTokenCount ?? 0;
  // Tokens fed back from built-in tools (Google Search, URL context, code
  // execution) are billed as input but reported beside promptTokenCount.
  const toolUsePrompt = usage.toolUsePromptTokenCount ?? 0;
  return {
    input:
      Math.max(0, (usage.promptTokenCount ?? 0) - cacheRead) + toolUsePrompt,
    output: (usage.candidatesTokenCount ?? 0) + reasoning,
    cacheRead,
    cacheWrite: 0,
    reasoning,
  };
}

export function minimaxUsageTokens(usage: Minimax.Types.Usage) {
  return {
    input: usage.prompt_tokens,
    output: usage.completion_tokens,
  };
}

/**
 * Token counts for fetch-based observability.
 *
 * Unlike every OpenAI-wire provider, Ollama's native `/api/chat` has no `usage`
 * object — the counts are top-level `prompt_eval_count` / `eval_count` fields,
 * and they are `omitempty` on the wire so they are absent (not zero) on
 * non-final chunks. Ollama reports no cache tokens at all.
 */
export function ollamaNativeUsageTokens(response: {
  prompt_eval_count?: number;
  eval_count?: number;
}) {
  return {
    input: response.prompt_eval_count ?? 0,
    output: response.eval_count ?? 0,
    cacheRead: 0,
    cacheWrite: 0,
  };
}

/**
 * `reasoningOutsideCompletion` is the dialect of providers whose
 * `completion_tokens` leaves `reasoning_tokens` out (see
 * `reportsReasoningOutsideCompletion`). Reasoning is billed as output, so it
 * is folded in: `output` always includes reasoning.
 */
export function openAIUsageTokens(
  usage: OpenAi.Types.Usage,
  options: { reasoningOutsideCompletion?: boolean } = {},
) {
  // OpenAI reports cached tokens as a SUBSET already inside prompt_tokens, so
  // subtract them to get the uncached input and avoid double-counting.
  const cacheRead =
    (usage.prompt_tokens_details as { cached_tokens?: number } | undefined)
      ?.cached_tokens ?? 0;
  const details = usage.prompt_tokens_details as
    | { cache_write_tokens?: number; cache_write_1h_tokens?: number }
    | undefined;
  const cacheWrite = details?.cache_write_tokens ?? 0;
  const reasoning = reasoningTokensOf(usage);
  return {
    input: Math.max(0, (usage.prompt_tokens ?? 0) - cacheRead - cacheWrite),
    output:
      (usage.completion_tokens ?? 0) +
      (options.reasoningOutsideCompletion ? reasoning : 0),
    cacheRead,
    cacheWrite,
    cacheWrite1h: details?.cache_write_1h_tokens,
    reasoning,
  };
}

export function xaiUsageTokens(usage: OpenAi.Types.Usage) {
  return openAIUsageTokens(usage, { reasoningOutsideCompletion: true });
}

/**
 * Whether an OpenAI-wire provider's `completion_tokens` leaves
 * `completion_tokens_details.reasoning_tokens` out. xAI's does: its
 * `total_tokens` is prompt + completion + reasoning. Every other OpenAI-wire
 * provider, and every translator onto that wire, counts reasoning inside.
 */
export function reportsReasoningOutsideCompletion(
  provider: SupportedProvider,
): boolean {
  return provider === "xai";
}

/**
 * An OpenAI-wire usage object rewritten into one reasoning dialect: with
 * reasoning inside `completion_tokens`, or left out of it. `total_tokens`
 * counts reasoning either way, so it is left as reported.
 */
export function withReasoningOutsideCompletion<
  T extends Pick<
    OpenAi.Types.Usage,
    "completion_tokens" | "completion_tokens_details"
  >,
>(usage: T, outside: boolean): T {
  const reasoning = reasoningTokensOf(usage);
  if (!reasoning) return usage;
  const completion = usage.completion_tokens ?? 0;
  return {
    ...usage,
    completion_tokens: outside
      ? Math.max(0, completion - reasoning)
      : completion + reasoning,
  };
}

export function zhipuaiUsageTokens(usage: Zhipuai.Types.Usage) {
  return {
    input: usage.prompt_tokens,
    output: usage.completion_tokens,
  };
}

// === Internal helpers ===

function reasoningTokensOf(
  usage: Pick<OpenAi.Types.Usage, "completion_tokens_details">,
): number {
  return (
    (
      usage.completion_tokens_details as
        | { reasoning_tokens?: number }
        | undefined
    )?.reasoning_tokens ?? 0
  );
}
