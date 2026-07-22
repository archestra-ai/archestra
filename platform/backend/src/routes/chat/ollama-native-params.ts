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
 * The package gives no way to omit the field, so {@link OLLAMA_THINK_EXPLICIT_KEY}
 * rides along in the `options` bag to mark the intent as deliberate. The fetch
 * wrapper in `clients/llm-client.ts` reads it, strips it, and drops `think` when
 * it is absent. The marker never leaves this process.
 */
import { OLLAMA_THINK_EXPLICIT_KEY } from "@/clients/llm-client";
import type { ConfiguredParameters } from "@/types/model";

type OllamaProviderOptions = {
  options?: Record<string, number | number[] | string[] | boolean>;
  think?: boolean;
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
}): { ollama: OllamaProviderOptions } | undefined {
  const { configured, requestTemperature, maxOutputTokens } = params;

  const options: Record<string, number | number[] | string[] | boolean> = {};
  const setNumber = (key: string, value: number | undefined) => {
    if (value !== undefined) options[key] = value;
  };

  setNumber("num_ctx", configured?.num_ctx);
  setNumber(
    "num_predict",
    resolveNumPredict(configured?.num_predict, maxOutputTokens),
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
  // own default — see the note at the top of this file. The marker must be
  // written before `options` is attached below, or a turn whose only setting is
  // the thinking choice would have no `options` bag to carry it.
  if (configured?.reasoning_effort !== undefined) {
    ollama.think = configured.reasoning_effort !== "none";
    options[OLLAMA_THINK_EXPLICIT_KEY] = true;
  }

  if (Object.keys(options).length > 0) ollama.options = options;

  if (ollama.options === undefined && ollama.think === undefined) {
    return undefined;
  }
  return { ollama };
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
 */
function resolveNumPredict(
  configured: number | undefined,
  budget: number | undefined,
): number | undefined {
  if (budget === undefined) return configured;
  if (configured === undefined || configured < 0) return budget;
  return Math.min(configured, budget);
}
