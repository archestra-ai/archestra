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
 *
 * Legacy shared-window models (e.g. gpt-4: output 8192 == context 8192) count
 * `max_tokens` against the same window as the prompt, so requesting the full
 * output ceiling leaves zero prompt room and every request 400s with a
 * context-length error. When the context window is known, the budget is
 * additionally capped at half of it so the prompt always has room; for modern
 * models (output far below context) the cap never binds. This applies to the
 * Ollama context fallback too — `num_predict` is drawn from the same `num_ctx`
 * window as the prompt, so the full window would leave nothing to prompt with.
 */
export function resolveAgentMaxOutputTokens(params: {
  outputLength: number | null;
  contextLength?: number | null;
  ceiling: number;
  provider?: SupportedProvider;
}): number {
  const contextLength = sanitizeOutputLimit(params.contextLength ?? null);
  const base =
    sanitizeOutputLimit(params.outputLength) ??
    (isOllamaProvider(params.provider) && contextLength !== null
      ? contextLength
      : UNKNOWN_MODEL_OUTPUT_TOKENS);
  const sharedWindowCap =
    contextLength !== null
      ? Math.max(1, Math.floor(contextLength / 2))
      : Number.POSITIVE_INFINITY;
  return Math.min(params.ceiling, base, sharedWindowCap);
}
