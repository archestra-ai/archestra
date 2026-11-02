/**
 * The token usage of each provider's response, as the LLM metrics and the
 * proxy's adapters read it. It lives below both, so the metrics need no adapter
 * and the core layer no proxy route.
 */
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

export function cohereUsageTokens(usage: Cohere.Types.Usage) {
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
}) {
  // Gemini's cachedContentTokenCount is a SUBSET already inside promptTokenCount,
  // so subtract it to get the uncached input and avoid double-counting.
  const cacheRead = usage.cachedContentTokenCount ?? 0;
  return {
    input: Math.max(0, (usage.promptTokenCount ?? 0) - cacheRead),
    output: usage.candidatesTokenCount ?? 0,
    cacheRead,
    cacheWrite: 0,
    reasoning: usage.thoughtsTokenCount ?? 0,
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

export function openAIUsageTokens(usage: OpenAi.Types.Usage) {
  // OpenAI reports cached tokens as a SUBSET already inside prompt_tokens, so
  // subtract them to get the uncached input and avoid double-counting.
  const cacheRead =
    (usage.prompt_tokens_details as { cached_tokens?: number } | undefined)
      ?.cached_tokens ?? 0;
  const details = usage.prompt_tokens_details as
    | { cache_write_tokens?: number; cache_write_1h_tokens?: number }
    | undefined;
  const cacheWrite = details?.cache_write_tokens ?? 0;
  const reasoning =
    (
      usage.completion_tokens_details as
        | { reasoning_tokens?: number }
        | undefined
    )?.reasoning_tokens ?? 0;
  return {
    input: Math.max(0, (usage.prompt_tokens ?? 0) - cacheRead - cacheWrite),
    output: usage.completion_tokens ?? 0,
    cacheRead,
    cacheWrite,
    cacheWrite1h: details?.cache_write_1h_tokens,
    reasoning,
  };
}

export function zhipuaiUsageTokens(usage: Zhipuai.Types.Usage) {
  return {
    input: usage.prompt_tokens,
    output: usage.completion_tokens,
  };
}
