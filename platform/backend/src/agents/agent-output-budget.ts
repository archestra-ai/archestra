import type { SupportedProvider } from "@archestra/shared";
import { sanitizeOutputLimit } from "@/clients/models-dev-client";

/**
 * Output-token budget for an agent turn when the model's real output ceiling is
 * unknown. Chosen above the ~4096 provider/SDK default that was truncating large
 * tool-call payloads and final submission turns.
 */
const UNKNOWN_MODEL_OUTPUT_TOKENS = 8192;

/**
 * Resolve `maxOutputTokens` for an agent turn: the model's real output ceiling
 * (or a fallback when it is unknown/invalid), clamped by the operator ceiling.
 * The result never exceeds the model's real cap, so a small model never
 * receives an over-budget request from a known ceiling.
 *
 * The unknown-model fallback is provider-dependent: Ollama never caps output on
 * its own (`num_predict` defaults to generate-until-the-context-is-full), so the
 * context window is the honest ceiling for a local model missing from the
 * catalog — a hardcoded budget would truncate long generations mid-stream.
 * Hosted providers reject `max_tokens` above the model's real cap, so they keep
 * the conservative {@link UNKNOWN_MODEL_OUTPUT_TOKENS} budget.
 */
export function resolveAgentMaxOutputTokens(params: {
  provider: SupportedProvider | null;
  outputLength: number | null;
  contextLength: number | null;
  ceiling: number;
}): number {
  const fallback =
    params.provider === "ollama"
      ? (sanitizeOutputLimit(params.contextLength) ??
        UNKNOWN_MODEL_OUTPUT_TOKENS)
      : UNKNOWN_MODEL_OUTPUT_TOKENS;
  const base = sanitizeOutputLimit(params.outputLength) ?? fallback;
  return Math.min(params.ceiling, base);
}
