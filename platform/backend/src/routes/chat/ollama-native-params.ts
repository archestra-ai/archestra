/**
 * Builds the AI SDK `providerOptions` that carry a model's admin-configured
 * generation parameters to the native Ollama (`ollama-native`) provider on every
 * chat turn. The ollama-ai-provider-v2 provider-options key is `ollama`; its
 * `options` bag is forwarded verbatim into the native `/api/chat` request.
 *
 * Precedence: request body > per-model configured > omitted (Ollama then applies
 * its own Modelfile/server default). Only fields that resolve to a value are
 * sent, so an unset parameter inherits Ollama's default rather than forcing one.
 */
import type { ConfiguredParameters } from "@/types/model";

type OllamaProviderOptions = {
  options?: Record<string, number | number[] | string[]>;
  think?: boolean;
};

export function buildOllamaNativeProviderOptions(params: {
  configured: ConfiguredParameters | null | undefined;
  /** A request-body temperature override wins over the configured value. */
  requestTemperature?: number;
}): { ollama: OllamaProviderOptions } | undefined {
  const { configured, requestTemperature } = params;

  const options: Record<string, number | number[] | string[]> = {};
  const setNumber = (key: string, value: number | undefined) => {
    if (value !== undefined) options[key] = value;
  };

  setNumber("num_ctx", configured?.num_ctx);
  setNumber("num_predict", configured?.num_predict);
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
  if (Object.keys(options).length > 0) ollama.options = options;

  // ollama-ai-provider-v2 (AI SDK v6 line) accepts `think` as a boolean only, so
  // the effort enum maps to on/off here: `none` → false, any level → true.
  // Level granularity (low vs medium vs high) is a documented follow-up gated on
  // sending the native `think` string directly.
  if (configured?.reasoning_effort !== undefined) {
    ollama.think = configured.reasoning_effort !== "none";
  }

  if (ollama.options === undefined && ollama.think === undefined) {
    return undefined;
  }
  return { ollama };
}
