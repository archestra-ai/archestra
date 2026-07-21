import type { SupportedProvider } from "@archestra/shared";
import { sanitizeOutputLimit } from "@/clients/models-dev-client";

/**
 * Output-token budget for an agent turn when the model's real output ceiling is
 * unknown. Chosen above the ~4096 provider/SDK default that was truncating large
 * tool-call payloads and final submission turns.
 */
const UNKNOWN_MODEL_OUTPUT_TOKENS = 8192;

/**
 * Ollama never reports an output-token cap (its `num_predict` defaults to
 * "generate until the context is full"), and its models are almost never in the
 * models.dev catalog, so `outputLength` is always null for them. The generic
 * 8192 fallback then silently truncated large generations (notably app creation,
 * whose HTML flows through tool-call arguments). For Ollama, fall back to the
 * model's context window instead — output can never exceed context anyway.
 */
function isOllamaProvider(provider: SupportedProvider | undefined): boolean {
  return provider === "ollama" || provider === "ollama-native";
}

/**
 * Resolve `maxOutputTokens` for an agent turn: the model's real output ceiling
 * (or a fallback when it is unknown/invalid), clamped by the operator ceiling.
 * The result never exceeds the model's real cap, so a small model never receives
 * an over-budget request from a known ceiling.
 *
 * When the output ceiling is unknown: Ollama providers fall back to the model's
 * context window (see {@link isOllamaProvider}); every other provider keeps the
 * conservative {@link UNKNOWN_MODEL_OUTPUT_TOKENS}.
 */
export function resolveAgentMaxOutputTokens(params: {
  outputLength: number | null;
  ceiling: number;
  provider?: SupportedProvider;
  contextLength?: number | null;
}): number {
  const knownOutput = sanitizeOutputLimit(params.outputLength);
  if (knownOutput !== null) {
    return Math.min(params.ceiling, knownOutput);
  }

  if (isOllamaProvider(params.provider)) {
    const contextWindow = sanitizeOutputLimit(params.contextLength);
    if (contextWindow !== null) {
      return Math.min(params.ceiling, contextWindow);
    }
  }

  return Math.min(params.ceiling, UNKNOWN_MODEL_OUTPUT_TOKENS);
}
