import {
  isSupportedProvider,
  type SupportedProvider,
  SupportedProviders,
} from "@shared";
import { ModelModel } from "@/models";
import { ApiError, type Model } from "@/types";

export type ModelRouterResolution = {
  provider: SupportedProvider;
  modelId: string;
  requestedModel: string;
};

export async function resolveModelRoute(params: {
  requestedModel: string;
  allowedProviders?: Set<SupportedProvider>;
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

    const providerMatches = await ModelModel.findTextChatModelsByModelId({
      modelId: explicit.modelId,
      provider: explicit.provider,
    });

    if (providerMatches.length === 1) {
      return toResolution(providerMatches[0], requestedModel);
    }
    if (providerMatches.length > 1) {
      throw new ApiError(
        500,
        `Ambiguous model resolution: "${requestedModel}" matched ${providerMatches.length} models.`,
      );
    }
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

function toResolution(
  model: Model,
  requestedModel: string,
): ModelRouterResolution {
  return {
    provider: model.provider,
    modelId: model.modelId,
    requestedModel,
  };
}

function providerSortIndex(provider: SupportedProvider): number {
  const index = SupportedProviders.indexOf(provider);
  return index === -1 ? Number.MAX_SAFE_INTEGER : index;
}

export function sortRoutableModels(models: Model[]): Model[] {
  return [...models].sort((a, b) => {
    const providerCompare =
      providerSortIndex(a.provider) - providerSortIndex(b.provider);
    if (providerCompare !== 0) return providerCompare;
    return a.modelId.localeCompare(b.modelId);
  });
}
