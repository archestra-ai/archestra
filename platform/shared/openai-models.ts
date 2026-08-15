import type { ThinkingEffort } from "./thinking-effort";

/**
 * The `reasoning_effort` a chosen effort maps to, or null when the model is
 * outside {@link supportsOpenAiThinkingEffort} and should be sent no reasoning
 * effort at all.
 *
 * `low | medium | high` is the subset every reasoning model accepts, so the
 * mapping is identity. OpenAI also defines `none`, `minimal`, `xhigh` and
 * `max`, but support for those varies per model and per generation; staying
 * inside the common subset is what lets one control span the whole family.
 */
export function openAiReasoningEffortForEffort(
  modelId: string,
  effort: ThinkingEffort,
): ThinkingEffort | null {
  return supportsOpenAiThinkingEffort(modelId) ? effort : null;
}

/**
 * True when an OpenAI model takes `reasoning_effort` and honors the full
 * low/medium/high range.
 *
 * Deliberately narrow, because a false positive is a 400 on a real chat turn
 * while a false negative only hides the control. Two families qualify — the
 * `gpt-5` generations and the `o` series — minus three carve-outs:
 *
 * - `pro` models accept `high` and nothing else, so there is no choice to offer.
 * - `chat-latest` is the non-reasoning tier of each generation and rejects
 *   the field.
 * - the first `o1` wave (`o1-preview`, `o1-mini`) shipped before the knob
 *   existed and answers `Unknown parameter: 'reasoning_effort'`.
 *
 * The `openai` provider is an OpenAI-compatible bucket, not a vendor: the same
 * credential serves Fireworks, DeepSeek and Cerebras catalogs, whose ids are
 * vendor-prefixed with a slash. Those are rejected outright rather than
 * matched against OpenAI's naming.
 */
export function supportsOpenAiThinkingEffort(modelId: string): boolean {
  const id = modelId.toLowerCase();

  if (id.includes("/")) {
    return false;
  }

  // Family membership is decided before any carve-out, so an unrelated id that
  // happens to carry one of the carve-out tokens can never fall through to a
  // `true`.
  const isGpt5 = id.startsWith("gpt-5");
  const isOSeries =
    OPENAI_O_SERIES_RE.test(id) && !OPENAI_PRE_EFFORT_O1_RE.test(id);
  if (!isGpt5 && !isOSeries) {
    return false;
  }

  // `search` ids are a retrieval product with its own request shape, and
  // `chat-latest` is each generation's non-reasoning tier.
  if (id.includes("chat-latest") || id.includes("search")) {
    return false;
  }
  // Only the `gpt-5` pro tier is fixed at `high`; `o1-pro`/`o3-pro` take the
  // full range.
  return !(isGpt5 && OPENAI_PRO_TOKEN_RE.test(id));
}

// ===========================================================================
// Internal helpers
// ===========================================================================

/**
 * `pro` as a delimited token, so dated snapshots (`gpt-5-pro-2025-10-06`) are
 * covered without matching an id that merely contains the letters.
 */
const OPENAI_PRO_TOKEN_RE = /(?:^|[-/])pro(?:[-/]|$)/;

const OPENAI_O_SERIES_RE = /^o[134](?:$|-)/;

/** The o1 models that predate `reasoning_effort`, dated snapshots included. */
const OPENAI_PRE_EFFORT_O1_RE = /^o1-(?:mini|preview)/;
