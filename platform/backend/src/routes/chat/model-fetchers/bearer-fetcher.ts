import type { SupportedProvider } from "@archestra/shared";
import config from "@/config";
import { joinBaseUrl } from "@/utils/base-url";
import { fetchModelsWithBearerAuth } from "./openai-compatible";
import { type ModelInfo, PLACEHOLDER_API_KEY, type StaticModel } from "./types";

interface BearerRawModel {
  id: string;
  // Provider responses don't always include `created`, so treat it as optional
  // untrusted input rather than trusting the OpenAI-compatible schema.
  created?: number;
}

interface BearerFetcherDescriptor<
  TRaw extends { id: string } = BearerRawModel,
> {
  provider: SupportedProvider;
  configKey: keyof typeof config.llm;
  errorLabel: string;
  modelsPath?: string;
  placeholderToken?: boolean;
  filter?: (id: string) => boolean;
  mapModel?: (model: TRaw, provider: SupportedProvider) => ModelInfo;
  postProcess?: (models: ModelInfo[]) => ModelInfo[];
}

function defaultMapModel(
  model: BearerRawModel,
  provider: SupportedProvider,
): ModelInfo {
  return {
    id: model.id,
    displayName: model.id,
    provider,
    createdAt: model.created
      ? new Date(model.created * 1000).toISOString()
      : undefined,
  };
}

export function mapKeylessModel(
  model: { id: string; created?: number },
  provider: SupportedProvider,
): ModelInfo {
  return {
    id: model.id,
    displayName: model.id,
    provider,
    createdAt: model.created
      ? new Date(model.created * 1000).toISOString()
      : undefined,
  };
}

export function makeBearerFetcher<TRaw extends { id: string } = BearerRawModel>(
  descriptor: BearerFetcherDescriptor<TRaw>,
): (
  apiKey: string,
  baseUrlOverride?: string | null,
  extraHeaders?: Record<string, string> | null,
) => Promise<ModelInfo[]> {
  const {
    provider,
    configKey,
    errorLabel,
    modelsPath = "/models",
    placeholderToken = false,
    filter,
    mapModel = defaultMapModel as unknown as (
      model: TRaw,
      provider: SupportedProvider,
    ) => ModelInfo,
    postProcess,
  } = descriptor;

  return async (apiKey, baseUrlOverride, extraHeaders) => {
    const baseUrl = baseUrlOverride || config.llm[configKey].baseUrl;
    const data = await fetchModelsWithBearerAuth<{ data: TRaw[] }>({
      url: joinBaseUrl(baseUrl, modelsPath),
      apiKey: placeholderToken ? apiKey || PLACEHOLDER_API_KEY : apiKey,
      errorLabel,
      extraHeaders,
    });

    const filtered = filter
      ? data.data.filter((model) => filter(model.id))
      : data.data;
    const models = filtered.map((model) => mapModel(model, provider));

    return postProcess ? postProcess(models) : models;
  };
}

export function makeStaticFetcher(
  provider: SupportedProvider,
  models: readonly StaticModel[],
): () => Promise<ModelInfo[]> {
  return async () =>
    models.map((model) => ({
      id: model.id,
      displayName: model.displayName,
      provider,
    }));
}
