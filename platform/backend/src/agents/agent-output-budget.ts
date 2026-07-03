import { sanitizeOutputLimit } from "@/clients/models-dev-client";

/**
 * Output-token budget for an agent turn when the model's real output ceiling is
 * unknown. Chosen above the ~4096 provider/SDK default that was truncating large
 * tool-call payloads and final submission turns.
 */
const UNKNOWN_MODEL_OUTPUT_TOKENS = 8192;

/**
 * Resolve `maxOutputTokens` for an agent turn: the model's real output ceiling
 * (or {@link UNKNOWN_MODEL_OUTPUT_TOKENS} when it is unknown/invalid), clamped by
 * the operator ceiling. The result never exceeds the model's real cap, so a small
 * model never receives an over-budget request from a known ceiling.
 */
export function resolveAgentMaxOutputTokens(params: {
  outputLength: number | null;
  ceiling: number;
}): number {
  const base =
    sanitizeOutputLimit(params.outputLength) ?? UNKNOWN_MODEL_OUTPUT_TOKENS;
  return Math.min(params.ceiling, base);
}
