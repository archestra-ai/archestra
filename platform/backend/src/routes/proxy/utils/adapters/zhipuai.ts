/**
 * @deprecated LEGACY ADAPTER - Used only by LLM Proxy metrics
 *
 * This adapter provides utility functions for Zhipuai token usage extraction.
 * Used by:
 * - src/llm-metrics.ts (for getObservableFetch token reporting)
 *
 * The main v2 adapter is at:
 * - src/routes/proxy/adapterV2/zhipuai.ts
 */
import type { Zhipuai } from "@/types";

/** Returns input and output usage tokens */
export function getUsageTokens(usage: Zhipuai.Types.Usage) {
  return {
    input: usage.prompt_tokens,
    output: usage.completion_tokens,
  };
}
