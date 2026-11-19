import logger from "@/logging";
import { llmUsageRollup } from "@/services/llm-usage-rollup";

/**
 * Periodic driver for the hourly LLM usage rollup. Bounded per run; the next
 * tick continues. Errors are logged, not rethrown, so the periodic chain
 * always reschedules; statistics read raw rows for whatever is not rolled.
 */
export async function handleLlmUsageRollup(): Promise<void> {
  try {
    const result = await llmUsageRollup.run();
    if (result.recomputed > 0 || result.rolled > 0) {
      logger.debug(result, "LLM usage rollup tick");
    }
  } catch (error) {
    logger.error({ err: error }, "LLM usage rollup tick failed");
  }
}
