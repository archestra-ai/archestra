import {
  ModelInputModalitySchema,
  ModelOutputModalitySchema,
  ReasoningEffortLevelSchema,
  type SupportedProviderEndpoint,
} from "@archestra/shared";
import { z } from "zod";
import { ModelModel } from "@/models";
import type { ProviderPricedModel } from "@/types/provider-model-pricing";
import {
  modelRouterServesEndpoint,
  nativeResponsesProvider,
} from "./model-router-access";

/**
 * Per-model settings on a Unified Model API `/models` entry, beside the
 * OpenAI-compatible `id`/`owned_by`. Snake case like the rest of that wire.
 * The same values as `capabilities` on `GET /api/llm-models/available`, except
 * `supported_endpoints`, which names the Unified Model API endpoints that serve
 * the model rather than the provider's own surfaces: the router translates
 * between Chat Completions and Responses for most providers.
 */
export const RoutableModelCapabilitiesSchema = z.object({
  context_length: z.number().int().nullable(),
  max_output_tokens: z.number().int().nullable(),
  input_modalities: z.array(ModelInputModalitySchema).nullable(),
  output_modalities: z.array(ModelOutputModalitySchema).nullable(),
  supports_tools: z.boolean().nullable(),
  supports_vision: z.boolean().nullable(),
  supports_reasoning_effort: z.boolean().nullable(),
  supported_reasoning_efforts: z.array(ReasoningEffortLevelSchema).nullable(),
  supported_endpoints: z.array(
    z.enum(["/chat/completions", "/responses", "/embeddings"]),
  ),
});
type RoutableModelCapabilities = z.infer<
  typeof RoutableModelCapabilitiesSchema
>;

/** The `capabilities` object of one routable model's `/models` entry. */
export function describeRoutableModel(params: {
  model: ProviderPricedModel;
  /** The id a client sends as `model`, e.g. `openai:gpt-5.5`. */
  routableId: string;
}): RoutableModelCapabilities {
  const { model, routableId } = params;
  const capabilities = ModelModel.toCapabilities(model);
  return {
    context_length: capabilities.contextLength,
    max_output_tokens: capabilities.outputLength,
    input_modalities: capabilities.inputModalities,
    output_modalities: capabilities.outputModalities,
    supports_tools: capabilities.supportsToolCalling,
    supports_vision: capabilities.inputModalities
      ? capabilities.inputModalities.includes("image")
      : null,
    supports_reasoning_effort: capabilities.supportsReasoningEffort,
    supported_reasoning_efforts: capabilities.supportedReasoningEfforts,
    supported_endpoints: routerEndpoints({
      model,
      routableId,
      supportedEndpoints: capabilities.supportedEndpoints ?? null,
    }),
  };
}

// ===== Internal helpers =====

/**
 * The Unified Model API endpoints a request for this model is served on. The
 * provider surfaces resolved for the catalogue (Azure's deployment evidence
 * included) feed the same check the router applies at request time, so a
 * Responses-only deployment is not advertised on Chat Completions. Image and
 * audio models list none of these: they are served on the media endpoints.
 */
function routerEndpoints(params: {
  model: ProviderPricedModel;
  routableId: string;
  supportedEndpoints: SupportedProviderEndpoint[] | null;
}): RoutableModelCapabilities["supported_endpoints"] {
  const { model, routableId } = params;
  if (ModelModel.supportsEmbeddings(model)) return ["/embeddings"];
  if (!ModelModel.supportsTextChat(model)) return [];
  const resolution = {
    provider: model.provider,
    modelId: model.modelId,
    requestedModel: routableId,
    supportedEndpoints: params.supportedEndpoints,
  };
  return (
    [
      ["chat_completions", "/chat/completions"],
      ["responses", "/responses"],
    ] as const
  )
    .filter(
      ([endpoint]) =>
        modelRouterServesEndpoint(resolution, endpoint) &&
        // A Responses request the router forwards natively reaches the
        // provider's own Responses API, so a model known not to be served
        // there (OpenAI's audio and search models) is not served on it.
        !(
          endpoint === "responses" &&
          params.supportedEndpoints &&
          !params.supportedEndpoints.includes("/responses") &&
          nativeResponsesProvider(resolution) !== null
        ),
    )
    .map(([, path]) => path);
}
