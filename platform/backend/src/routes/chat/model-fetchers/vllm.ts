import type { SupportedProvider } from "@archestra/shared";
import { makeBearerFetcher } from "./bearer-fetcher";
import type { ModelInfo } from "./types";

interface VllmRawModel {
  id: string;
  created?: number;
  /** Untyped at the boundary: this is whatever the server serialised. */
  max_model_len?: unknown;
}

export const fetchVllmModels = makeBearerFetcher<VllmRawModel>({
  provider: "vllm",
  configKey: "vllm",
  errorLabel: "vLLM models",
  placeholderToken: true,
  mapModel: mapVllmModel,
});

/**
 * vLLM reports the context window the server was launched with, including any
 * `--max-model-len` override, so it is the only source that describes this
 * deployment rather than the model in general. Registry entries for one model
 * disagree by an order of magnitude precisely because each deployment sets its
 * own.
 *
 * Absent stays `undefined` rather than null so an older server that omits the
 * field falls through to the tiers below instead of pinning the column empty.
 */
function mapVllmModel(
  model: VllmRawModel,
  provider: SupportedProvider,
): ModelInfo {
  const contextLength = readPositiveInteger(model.max_model_len);
  return {
    id: model.id,
    displayName: model.id,
    provider,
    createdAt: model.created
      ? new Date(model.created * 1000).toISOString()
      : undefined,
    ...(contextLength === undefined ? {} : { capabilities: { contextLength } }),
  };
}

/**
 * The value lands in an integer column at the top of the capability priority
 * chain, where no later tier can correct it, and nothing between here and there
 * validates the response body. Anything that is not already a positive integer
 * is discarded rather than coerced.
 */
function readPositiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : undefined;
}
