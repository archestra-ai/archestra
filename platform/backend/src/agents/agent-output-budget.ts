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
 *
 * Legacy shared-window models (e.g. gpt-4: output 8192 == context 8192) count
 * `max_tokens` against the same window as the prompt, so requesting the full
 * output ceiling leaves zero prompt room and every request 400s with a
 * context-length error. When the context window is known, the budget is
 * additionally capped at half of it so the prompt always has room; for modern
 * models (output far below context) the cap never binds.
 */
export function resolveAgentMaxOutputTokens(params: {
  outputLength: number | null;
  contextLength?: number | null;
  ceiling: number;
}): number {
  const base =
    sanitizeOutputLimit(params.outputLength) ?? UNKNOWN_MODEL_OUTPUT_TOKENS;
  const contextLength = sanitizeOutputLimit(params.contextLength ?? null);
  const sharedWindowCap =
    contextLength !== null
      ? Math.max(1, Math.floor(contextLength / 2))
      : Number.POSITIVE_INFINITY;
  return Math.min(params.ceiling, base, sharedWindowCap);
}
