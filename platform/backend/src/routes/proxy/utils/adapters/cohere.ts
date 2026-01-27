/**
 * @deprecated LEGACY ADAPTER - Used only by LLM Proxy v1 routes and metrics
 *
 * This adapter provides utility functions for Cohere API responses.
 * The new unified LLM proxy handler uses the adapter system in:
 * - src/routes/proxy/adapterV2/cohere.ts
 */
import type { Cohere } from "@/types";

/** Returns input and output usage tokens from Cohere usage object */
export function getUsageTokens(usage: Cohere.Types.Usage) {
  return {
    input:
      usage?.tokens?.input_tokens ?? usage?.billed_units?.input_tokens ?? 0,
    output:
      usage?.tokens?.output_tokens ?? usage?.billed_units?.output_tokens ?? 0,
  };
}
