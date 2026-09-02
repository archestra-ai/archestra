/**
 * Builds the complete `providerOptions.openrouter` object for a chat turn.
 *
 * Only reasoning depth lives here today, but the key is assigned wholesale by
 * the caller — a second assignment would replace the first — so this stays the
 * one writer, the way the Anthropic and Gemini builders do for their keys.
 *
 * The depth rides OpenRouter's unified `reasoning` object rather than OpenAI's
 * top-level `reasoning_effort`, even though the transport is OpenAI-compatible
 * and the SDK would happily send the latter. `reasoning` is the wider door: of
 * the models OpenRouter reports as reasoning-capable, every one accepts
 * `reasoning` while only about half also accept `reasoning_effort` — the rest
 * are models whose upstream takes a token budget instead, and for those
 * OpenRouter translates the effort into one itself. Sending `reasoning_effort`
 * would silently reach nothing on that half.
 *
 * `low | medium | high` is OpenRouter's own vocabulary, so our levels pass
 * through unmapped — no per-model catalog to consult, which is the point of
 * routing through it.
 *
 * Deliberately not gated on the model row a second time. The composer already
 * hides the control unless the row says the model reasons, and OpenRouter
 * ignores the field on a model that does not (verified: a non-reasoning model
 * answers normally with zero reasoning tokens, where Ollama would reject the
 * request outright). A row-level gate here would instead cost the depth on any
 * reasoning model whose row has not yet picked up `supported_parameters`.
 *
 * @see https://openrouter.ai/docs/guides/best-practices/reasoning
 */
import type { ThinkingEffort, ThinkingEffortSetting } from "@archestra/shared";

type OpenRouterProviderOptions = {
  reasoning: { effort: ThinkingEffort };
};

/**
 * Returns undefined when the turn needs no OpenRouter-specific options, so the
 * caller can leave `providerOptions` untouched.
 */
export function buildOpenRouterProviderOptions(params: {
  provider: string;
  thinkingEffort: ThinkingEffortSetting;
}): OpenRouterProviderOptions | undefined {
  const { provider, thinkingEffort } = params;

  // No chosen depth sends no field at all, so the model reasons as it would.
  if (provider !== "openrouter" || thinkingEffort === null) {
    return undefined;
  }

  return { reasoning: { effort: thinkingEffort } };
}
