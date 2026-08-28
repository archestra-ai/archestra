import {
  isSupportedProvider,
  type SupportedProvider,
  type SupportedProviderEndpoint,
  SupportedProviders,
} from "@archestra/shared";
import { LlmProviderApiKeyModelLinkModel, ModelModel } from "@/models";
import { ApiError, type Model } from "@/types";

export type ModelRouterResolution = {
  provider: SupportedProvider;
  modelId: string;
  requestedModel: string;
  /**
   * The wire surfaces the provider published for this model, carried through so
   * the router can pick between a provider's chat and Responses surfaces the
   * same way the chat path does. Null for the providers that serve exactly one
   * surface, which is all of them but GitHub Copilot.
   */
  supportedEndpoints: SupportedProviderEndpoint[] | null;
};

export async function resolveModelRoute(params: {
  requestedModel: string;
  capability?: "text-chat" | "embeddings";
  allowedProviders?: Set<SupportedProvider>;
  allowedApiKeyIds?: string[];
}): Promise<ModelRouterResolution> {
  const requestedModel = params.requestedModel.trim();
  if (!requestedModel) {
    throw new ApiError(400, "Model is required.");
  }

  const explicit = parseProviderQualifiedModel(requestedModel);
  if (explicit) {
    if (
      params.allowedProviders &&
      !params.allowedProviders.has(explicit.provider)
    ) {
      throw new ApiError(
        400,
        `Model "${requestedModel}" is scoped to provider "${explicit.provider}", but the Model Router virtual key is not mapped to that provider.`,
      );
    }

    return resolveProviderModel({
      provider: explicit.provider,
      modelId: explicit.modelId,
      requestedModel,
      capability: params.capability,
      allowedApiKeyIds: params.allowedApiKeyIds,
    });
  }

  // Native clients such as Codex and Hermes expect the provider's own model
  // slug. A virtual key mapped to exactly one provider makes that slug just as
  // unambiguous as a qualified id while preserving strict routing for general
  // multi-provider Model Router keys.
  if (params.allowedProviders?.size === 1) {
    const [provider] = params.allowedProviders;
    return resolveProviderModel({
      provider,
      modelId: requestedModel,
      requestedModel,
      capability: params.capability,
      allowedApiKeyIds: params.allowedApiKeyIds,
    });
  }

  throw new ApiError(
    404,
    `Model "${requestedModel}" is not available. Use a provider-qualified model id such as "anthropic:claude-opus-4-6-20250918".`,
  );
}

export function parseProviderQualifiedModel(
  model: string,
): { provider: SupportedProvider; modelId: string } | null {
  const separatorIndex = model.indexOf(":");
  if (separatorIndex <= 0 || separatorIndex === model.length - 1) {
    return null;
  }

  const provider = model.slice(0, separatorIndex);
  if (!isSupportedProvider(provider)) {
    return null;
  }

  return {
    provider,
    modelId: model.slice(separatorIndex + 1),
  };
}

export function buildRoutableModelId(model: Model): string {
  return `${model.provider}:${model.modelId}`;
}

export function sortRoutableModels(models: Model[]): Model[] {
  return [...models].sort((a, b) => {
    const providerCompare =
      providerSortIndex(a.provider) - providerSortIndex(b.provider);
    if (providerCompare !== 0) return providerCompare;
    return a.modelId.localeCompare(b.modelId);
  });
}

function toResolution(
  model: Model,
  requestedModel: string,
): ModelRouterResolution {
  return {
    provider: model.provider,
    modelId: model.modelId,
    requestedModel,
    supportedEndpoints: model.supportedEndpoints ?? null,
  };
}

async function resolveProviderModel(params: {
  provider: SupportedProvider;
  modelId: string;
  requestedModel: string;
  capability?: "text-chat" | "embeddings";
  allowedApiKeyIds?: string[];
}): Promise<ModelRouterResolution> {
  const providerMatches =
    params.capability === "embeddings"
      ? await ModelModel.findEmbeddingModelsByModelId({
          modelId: params.modelId,
          provider: params.provider,
        })
      : await ModelModel.findTextChatModelsByModelId({
          modelId: params.modelId,
          provider: params.provider,
        });

  const accessibleMatches = params.allowedApiKeyIds
    ? await filterModelsByLinkedApiKeys(
        providerMatches,
        params.allowedApiKeyIds,
      )
    : providerMatches;

  if (accessibleMatches.length === 1) {
    return toResolution(accessibleMatches[0], params.requestedModel);
  }
  if (accessibleMatches.length > 1) {
    throw new ApiError(
      500,
      `Ambiguous model resolution: "${params.requestedModel}" matched ${accessibleMatches.length} models.`,
    );
  }

  throw modelNotAvailableError(params.requestedModel);
}

function modelNotAvailableError(requestedModel: string): ApiError {
  return new ApiError(
    404,
    `Model "${requestedModel}" is not available. Use a provider-qualified model id such as "anthropic:claude-opus-4-6-20250918".`,
  );
}

function providerSortIndex(provider: SupportedProvider): number {
  const index = SupportedProviders.indexOf(provider);
  return index === -1 ? Number.MAX_SAFE_INTEGER : index;
}

async function filterModelsByLinkedApiKeys(
  models: Model[],
  apiKeyIds: string[],
): Promise<Model[]> {
  if (models.length === 0 || apiKeyIds.length === 0) {
    return [];
  }
  const linked =
    await LlmProviderApiKeyModelLinkModel.getModelsForApiKeyIds(apiKeyIds);
  const linkedIds = new Set(linked.map(({ model }) => model.id));
  return models.filter((model) => linkedIds.has(model.id));
}
