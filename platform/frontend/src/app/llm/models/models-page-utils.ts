import { compareModelsForDisplay } from "@archestra/shared";

export type ModelsPageModelTypeFilter = "all" | "chat" | "embedding";

export type ModelsPageAvailableApiKey = readonly [string, { provider: string }];

export const OBSERVED_MODEL_SOURCE_LABEL = "Observed in requests";
export const OBSERVED_MODEL_SOURCE_DESCRIPTION =
  "This model was first seen in traffic through a model gateway. It may not appear in a provider catalog.";

export type ModelsPageFilterableModel = {
  modelId: string;
  provider: string;
  apiKeys: readonly { id: string }[];
  embeddingDimensions: number | null;
  isFree: boolean;
  isBest?: boolean | null;
};

export function canFilterFreeModelsForApiKey(params: {
  availableApiKeys: readonly ModelsPageAvailableApiKey[];
  apiKeyFilter: string;
}): boolean {
  const { availableApiKeys, apiKeyFilter } = params;

  if (apiKeyFilter === "all") {
    return availableApiKeys.some(([, key]) => key.provider === "openrouter");
  }

  const selectedApiKey = availableApiKeys.find(([id]) => id === apiKeyFilter);
  return selectedApiKey?.[1].provider === "openrouter";
}

export function filterModelsForPage<
  T extends ModelsPageFilterableModel,
>(params: {
  models: readonly T[];
  search: string;
  apiKeyFilter: string;
  modelTypeFilter: ModelsPageModelTypeFilter;
  freeOnly: boolean;
  canFilterFreeModels: boolean;
}): T[] {
  const {
    models,
    search,
    apiKeyFilter,
    modelTypeFilter,
    freeOnly,
    canFilterFreeModels,
  } = params;
  let result = models;

  if (search) {
    const query = search.toLowerCase();
    result = result.filter((model) =>
      model.modelId.toLowerCase().includes(query),
    );
  }
  if (apiKeyFilter !== "all") {
    result = result.filter((model) =>
      model.apiKeys.some((key) => key.id === apiKeyFilter),
    );
  }
  if (modelTypeFilter === "embedding") {
    result = result.filter((model) => model.embeddingDimensions !== null);
  } else if (modelTypeFilter === "chat") {
    result = result.filter((model) => model.embeddingDimensions === null);
  }
  if (freeOnly && canFilterFreeModels) {
    result = result.filter((model) => model.isFree);
  }

  return [...result].sort(
    (a, b) =>
      a.provider.localeCompare(b.provider) || compareModelsForDisplay(a, b),
  );
}
