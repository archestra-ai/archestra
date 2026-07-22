/**
 * Builds the AI SDK `providerOptions` that carry a model's configured
 * generation parameters to the native Ollama (`ollama-native`) provider on every
 * chat turn. The ollama-ai-provider-v2 provider-options key is `ollama`; its
 * `options` bag is forwarded verbatim into the native `/api/chat` request.
 *
 * Precedence: request body > per-model configured > omitted (Ollama then applies
 * its own Modelfile/server default). Only fields that resolve to a value are
 * sent, so an unset parameter inherits Ollama's default rather than forcing one.
 *
 * Note on thinking: ollama-ai-provider-v2 emits `think: ollamaOptions?.think ??
 * false`, collapsing "caller said nothing" into an explicit `false` on the wire.
 * That is not the same as omitting the field — `think: false` actively disables
 * thinking, and a qwen3-class model then emits its whole chain of thought as
 * message `content` (terminated by a bare `</think>` with no opening tag), which
 * renders as the assistant's answer. Omitting `think` is what the OpenAI-compatible
 * `/v1` provider does, and why thinking behaves correctly there.
 *
 * The package gives no way to omit the field, so {@link OLLAMA_THINK_EXPLICIT_HEADER}
 * is returned as a request header to mark the intent as deliberate. The fetch
 * wrapper in `clients/llm-client.ts` reads it, strips it, and drops `think` when
 * it is absent. The marker never leaves this process.
 *
 * It has to be a header: the package parses `providerOptions.ollama` through a
 * closed Zod object, so anything smuggled inside the `options` bag is stripped
 * before the request body is built and the wrapper would never see it.
 */
import { OLLAMA_THINK_EXPLICIT_HEADER } from "@/clients/llm-client";
import type { ConfiguredParameters } from "@/types/model";

type OllamaProviderOptions = {
  options?: Record<string, number | number[] | string[] | boolean>;
  think?: boolean;
};

/**
 * The `providerOptions` and `headers` to merge into this turn's `streamText`
 * config. `headers` is empty unless the thinking choice was set explicitly.
 */
export type OllamaNativeTurnConfig = {
  providerOptions: { ollama: OllamaProviderOptions };
  headers?: Record<string, string>;
};

export function buildOllamaNativeProviderOptions(params: {
  configured: ConfiguredParameters | null | undefined;
  /** A request-body temperature override wins over the configured value. */
  requestTemperature?: number;
  /**
   * Resolved output-token budget for this turn (see `resolveAgentMaxOutputTokens`).
   * Folded into `options.num_predict` — see {@link resolveNumPredict}.
   */
  maxOutputTokens?: number;
  /**
   * The window this turn actually runs with (`ModelModel.resolveEffectiveContextLength`),
   * already clamped to the model's architectural ceiling. Sent in place of the
   * raw configured `num_ctx` so the wire cannot disagree with what the context
   * ring and the Models table display.
   */
  effectiveContextLength?: number | null;
  /**
   * Estimated prompt size for this turn. `num_ctx` is shared between prompt and
   * generation, so the budget is additionally trimmed to what the prompt leaves
   * — see {@link resolveNumPredict}.
   */
  promptTokens?: number | null;
}): OllamaNativeTurnConfig | undefined {
  const {
    configured,
    requestTemperature,
    maxOutputTokens,
    effectiveContextLength,
    promptTokens,
  } = params;

  const options: Record<string, number | number[] | string[] | boolean> = {};
  const setNumber = (key: string, value: number | undefined) => {
    if (value !== undefined) options[key] = value;
  };

  // Only send `num_ctx` when an admin configured one — the effective length
  // also covers a Modelfile value, which Ollama already applies on its own.
  if (configured?.num_ctx !== undefined) {
    setNumber("num_ctx", effectiveContextLength ?? configured.num_ctx);
  }
  setNumber(
    "num_predict",
    resolveNumPredict({
      configured: configured?.num_predict,
      budget: maxOutputTokens,
      remainingContext: resolveRemainingContext({
        effectiveContextLength,
        promptTokens,
      }),
    }),
  );
  setNumber("top_k", configured?.top_k);
  setNumber("top_p", configured?.top_p);
  setNumber("repeat_penalty", configured?.repeat_penalty);
  setNumber("seed", configured?.seed);
  if (configured?.stop !== undefined) options.stop = configured.stop;

  // Temperature precedence: an explicit request-body value overrides the
  // configured one. Ollama reads temperature from `options`, so map it there
  // (the AI SDK's top-level `temperature` field is not a native `/api/chat`
  // field and would be ignored).
  const temperature = requestTemperature ?? configured?.temperature;
  if (temperature !== undefined) options.temperature = temperature;

  const ollama: OllamaProviderOptions = {};

  // ollama-ai-provider-v2 (AI SDK v6 line) accepts `think` as a boolean only, so
  // the stored enum maps to on/off here: `none` → false, anything else → true.
  // The UI offers only Inherit/On/Off for that reason; older rows may still hold
  // "low"/"high", which all mean on.
  //
  // Set only when a value was explicitly chosen. Left unset, the package emits
  // `think: false`, which the fetch wrapper strips so Ollama applies the model's
  // own default — see the note at the top of this file.
  let headers: Record<string, string> | undefined;
  if (configured?.reasoning_effort !== undefined) {
    ollama.think = configured.reasoning_effort !== "none";
    headers = { [OLLAMA_THINK_EXPLICIT_HEADER]: "1" };
  }

  if (Object.keys(options).length > 0) ollama.options = options;

  if (ollama.options === undefined && ollama.think === undefined) {
    return undefined;
  }
  return { providerOptions: { ollama }, headers };
}

// =============================================================================
// INTERNAL HELPERS
// =============================================================================

/**
 * Ollama caps output length via `options.num_predict`. The AI SDK's
 * `maxOutputTokens` is emitted by ollama-ai-provider-v2 as a top-level
 * `max_output_tokens`, which is not an `/api/chat` field — Ollama's decoder
 * discards it, so the operator ceiling never reaches the model. Fold the
 * resolved budget in here instead, taking whichever cap is tighter.
 *
 * `num_predict` carries two negative sentinels — `-1` (generate until the
 * context fills) and `-2` (fill the context) — so a plain `Math.min` would
 * select the sentinel and remove the cap entirely. Treat a negative configured
 * value as "no explicit cap" and let the budget win.
 *
 * `remainingContext` trims the result again. Unlike the other providers, Ollama
 * draws prompt and generation from the same `num_ctx`, so a budget resolved
 * purely from the window size can exceed what the prompt actually left. The
 * overflow gate deliberately does not reject those requests — for Ollama the
 * budget is often exactly half the window, so gating on it would refuse every
 * prompt above 50% — the budget is simply fitted to the space instead.
 */
function resolveNumPredict(params: {
  configured: number | undefined;
  budget: number | undefined;
  remainingContext: number | undefined;
}): number | undefined {
  const { configured, budget, remainingContext } = params;

  const capped =
    budget === undefined
      ? configured
      : configured === undefined || configured < 0
        ? budget
        : Math.min(configured, budget);

  if (capped === undefined || capped < 0 || remainingContext === undefined) {
    return capped;
  }
  return Math.min(capped, remainingContext);
}

/**
 * How much of the window is left for generation once the prompt is in it.
 * Undefined when either input is unknown, and floored at 1 so a prompt that
 * already fills the window still asks for a token rather than sending
 * `num_predict: 0`, which Ollama reads as "generate nothing".
 */
function resolveRemainingContext(params: {
  effectiveContextLength: number | null | undefined;
  promptTokens: number | null | undefined;
}): number | undefined {
  const { effectiveContextLength, promptTokens } = params;
  if (!effectiveContextLength || promptTokens == null) return undefined;
  return Math.max(1, effectiveContextLength - promptTokens);
}
