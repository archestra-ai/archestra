import {
  archestraApiSdk,
  type archestraApiTypes,
  type SupportedProvider,
} from "@shared";
import {
  keepPreviousData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useMemo } from "react";
import { toast } from "sonner";
import { handleApiError } from "@/lib/utils";

const { getLlmModels, getModelsWithApiKeys, updateModel, syncLlmModels } =
  archestraApiSdk;
type LlmModelsQuery = NonNullable<archestraApiTypes.GetLlmModelsData["query"]>;
type LlmModelsParams = Partial<LlmModelsQuery> & {
  enabled?: boolean;
};

type LlmModelsResponse = archestraApiTypes.GetLlmModelsResponses["200"];
export type LlmModel = LlmModelsResponse["data"][number];
export type ModelCapabilities = NonNullable<LlmModel["capabilities"]>;
export type ModelWithApiKeys =
  archestraApiTypes.GetModelsWithApiKeysResponses["200"][number];
export type LinkedApiKey = ModelWithApiKeys["apiKeys"][number];

/**
 * Fetch available chat models from all configured providers.
 * When apiKeyId is provided, only returns models linked to that specific key.
 */
export function useLlmModels(params?: LlmModelsParams) {
  return useQuery({
    queryKey: ["llm-models", "all", params],
    queryFn: async (): Promise<LlmModel[]> => {
      const models: LlmModel[] = [];
      let cursor: string | undefined;

      do {
        const data = await fetchLlmModelsPage({
          params: { ...params, limit: 100 },
          cursor,
        });
        models.push(...data.data);
        cursor = data.pagination.nextCursor ?? undefined;
      } while (cursor);

      return models;
    },
    // Keep showing previous models while fetching for a new apiKeyId,
    // preventing display name flicker (e.g. "Claude Opus 4.1" → raw ID → back).
    placeholderData: keepPreviousData,
    enabled: params?.enabled,
  });
}

/**
 * Fetch embedding models for a specific API key.
 * Returns only models with configured embedding dimensions for the given API key.
 */
export function useEmbeddingModels(apiKeyId: string | null) {
  return useQuery({
    queryKey: ["llm-models", "embedding", apiKeyId],
    queryFn: async (): Promise<LlmModel[]> => {
      if (!apiKeyId) return [];
      const models: LlmModel[] = [];
      let cursor: string | undefined;

      do {
        const data = await fetchLlmModelsPage({
          params: { apiKeyId, isEmbedding: "true", limit: 100 },
          cursor,
        });
        models.push(...data.data);
        cursor = data.pagination.nextCursor ?? undefined;
      } while (cursor);

      return models;
    },
    enabled: !!apiKeyId,
    placeholderData: keepPreviousData,
  });
}

/**
 * Get models grouped by provider for UI display.
 * Returns models grouped by provider with loading/error states.
 * When apiKeyId is provided, only returns models linked to that specific key.
 */
export function useLlmModelsByProvider(params?: LlmModelsParams) {
  const query = useLlmModels(params);

  // Memoize to prevent creating new object reference on every render
  const modelsByProvider = useMemo(
    () => groupModelsByProvider(query.data ?? []),
    [query.data],
  );

  return {
    ...query,
    modelsByProvider,
    isPlaceholderData: query.isPlaceholderData,
  };
}

export function useInfiniteLlmModelsByProvider(params?: LlmModelsParams) {
  const limit = params?.limit ?? 50;
  const query = useInfiniteQuery({
    queryKey: ["llm-models", "infinite", params],
    queryFn: async ({ pageParam }): Promise<LlmModelsResponse> => {
      return fetchLlmModelsPage({
        params: { ...params, limit },
        cursor: pageParam,
      });
    },
    getNextPageParam: (lastPage) =>
      lastPage.pagination.hasNext
        ? (lastPage.pagination.nextCursor ?? undefined)
        : undefined,
    initialPageParam: undefined as string | undefined,
    enabled: params?.enabled,
    placeholderData: keepPreviousData,
  });

  const models = useMemo(
    () => query.data?.pages.flatMap((page) => page.data) ?? [],
    [query.data],
  );
  const modelsByProvider = useMemo(
    () => groupModelsByProvider(models),
    [models],
  );

  return {
    ...query,
    models,
    modelsByProvider,
  };
}

export function useAvailableLlmModel(params: {
  modelId: string | null | undefined;
  apiKeyId?: string | null;
  provider?: SupportedProvider;
  enabled?: boolean;
}) {
  return useQuery({
    queryKey: [
      "llm-models",
      "available-model",
      params.modelId ?? null,
      params.apiKeyId ?? null,
      params.provider ?? null,
    ],
    queryFn: async (): Promise<LlmModel | null> => {
      if (!params.modelId) return null;

      const data = await fetchLlmModelsPage({
        params: {
          apiKeyId: params.apiKeyId ?? undefined,
          provider: params.provider,
          modelId: params.modelId,
          limit: 1,
        },
      });
      return data.data[0] ?? null;
    },
    enabled: params.enabled !== false && !!params.modelId,
  });
}

export function useModelsWithApiKeys() {
  return useQuery({
    queryKey: ["models-with-api-keys"],
    queryFn: async (): Promise<ModelWithApiKeys[]> => {
      const { data, error } = await getModelsWithApiKeys();
      if (error) {
        handleApiError(error);
        return [];
      }
      return data ?? [];
    },
  });
}

/**
 * Update model details (pricing + modalities).
 * Set prices to null to reset to default pricing.
 */
export function useUpdateModel() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (
      params: archestraApiTypes.UpdateModelData["body"] & { id: string },
    ) => {
      const { id, ...body } = params;
      const { data, error } = await updateModel({
        path: { id },
        body,
      });
      if (error) {
        handleApiError(error);
        return null;
      }
      return data;
    },
    onSuccess: () => {
      toast.success("Model updated");
      queryClient.invalidateQueries({ queryKey: ["models-with-api-keys"] });
      queryClient.invalidateQueries({ queryKey: ["llm-models"] });
    },
    onError: () => {
      toast.error("Failed to update model");
    },
  });
}

export function useSyncLlmModels() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const { data: responseData, error } = await syncLlmModels();
      if (error) {
        handleApiError(error);
        throw error;
      }
      return responseData;
    },
    onSuccess: (data) => {
      if (!data) return;
      toast.success("Models synced");
      queryClient.invalidateQueries({ queryKey: ["llm-models"] });
      queryClient.invalidateQueries({ queryKey: ["models-with-api-keys"] });
    },
  });
}

async function fetchLlmModelsPage({
  params,
  cursor,
}: {
  params?: LlmModelsParams;
  cursor?: string;
}): Promise<LlmModelsResponse> {
  const { enabled: _enabled, ...queryParams } = params ?? {};
  const { data, error } = await getLlmModels({
    query: {
      ...queryParams,
      cursor,
    },
  });
  if (error) {
    handleApiError(error);
    return {
      data: [],
      pagination: {
        limit: queryParams.limit ?? 50,
        nextCursor: null,
        hasNext: false,
      },
    };
  }
  return (
    data ?? {
      data: [],
      pagination: {
        limit: queryParams.limit ?? 50,
        nextCursor: null,
        hasNext: false,
      },
    }
  );
}

function groupModelsByProvider(models: LlmModel[]) {
  return models.reduce(
    (acc, model) => {
      if (!acc[model.provider]) {
        acc[model.provider] = [];
      }
      acc[model.provider].push(model);
      return acc;
    },
    {} as Record<SupportedProvider, LlmModel[]>,
  );
}
