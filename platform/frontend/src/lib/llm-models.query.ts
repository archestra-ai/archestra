import {
  archestraApiSdk,
  type archestraApiTypes,
  calculatePaginationMeta,
  type ModelInputModality,
  type PaginationMeta,
  type SupportedProvider,
} from "@shared";
import {
  keepPreviousData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useEffect, useMemo } from "react";
import { toast } from "sonner";
import { handleApiError } from "@/lib/utils";

const { getLlmModels, getModelsWithApiKeys, updateModel, syncLlmModels } =
  archestraApiSdk;
type GeneratedLlmModelsQuery = NonNullable<
  archestraApiTypes.GetLlmModelsData["query"]
>;
type LlmModelsParams = Partial<GeneratedLlmModelsQuery> & {
  q?: string;
  modelId?: string;
  inputModalities?: ModelInputModality[];
  supportsToolCalling?: string;
  limit?: number;
  offset?: number;
  enabled?: boolean;
};

type GeneratedLlmModelsResponse = archestraApiTypes.GetLlmModelsResponses["200"];
export type LlmModel =
  GeneratedLlmModelsResponse extends { data: Array<infer T> }
    ? T
    : GeneratedLlmModelsResponse extends Array<infer T>
      ? T
      : never;
type LlmModelsResponse = {
  data: LlmModel[];
  pagination: PaginationMeta;
};
export type ModelCapabilities = NonNullable<LlmModel["capabilities"]>;
export type ModelWithApiKeys =
  archestraApiTypes.GetModelsWithApiKeysResponses["200"][number];
export type LinkedApiKey = ModelWithApiKeys["apiKeys"][number];

export function useLlmModels(params?: LlmModelsParams) {
  const query = useInfiniteLlmModels(params);

  useEffect(() => {
    if (query.hasNextPage && !query.isFetchingNextPage) {
      void query.fetchNextPage();
    }
  }, [query.hasNextPage, query.isFetchingNextPage, query.fetchNextPage]);

  return {
    ...query,
    data: query.models,
  };
}

export function useLlmModelsPage(params?: LlmModelsParams) {
  return useQuery({
    queryKey: ["llm-models", "page", params],
    queryFn: async (): Promise<LlmModelsResponse> => {
      return fetchLlmModelsPage({ params });
    },
    placeholderData: keepPreviousData,
    enabled: params?.enabled,
  });
}

export function useInfiniteEmbeddingModels(params: {
  apiKeyId: string | null | undefined;
  q?: string;
  limit?: number;
  enabled?: boolean;
}) {
  return useInfiniteLlmModels({
    apiKeyId: params.apiKeyId ?? undefined,
    isEmbedding: "true",
    q: params.q,
    limit: params.limit ?? 50,
    enabled: params.enabled !== false && !!params.apiKeyId,
  });
}

export function useEmbeddingModels(apiKeyId: string | null) {
  const query = useInfiniteEmbeddingModels({ apiKeyId });

  useEffect(() => {
    if (query.hasNextPage && !query.isFetchingNextPage) {
      void query.fetchNextPage();
    }
  }, [query.hasNextPage, query.isFetchingNextPage, query.fetchNextPage]);

  return {
    ...query,
    data: query.models,
  };
}

export function useInfiniteLlmModels(params?: LlmModelsParams) {
  const limit = params?.limit ?? 50;
  const query = useInfiniteQuery({
    queryKey: ["llm-models", "infinite", params],
    queryFn: async ({ pageParam }): Promise<LlmModelsResponse> => {
      return fetchLlmModelsPage({
        params: { ...params, limit, offset: pageParam },
      });
    },
    getNextPageParam: (lastPage) =>
      lastPage.pagination.hasNext
        ? lastPage.pagination.currentPage * lastPage.pagination.limit
        : undefined,
    initialPageParam: 0,
    enabled: params?.enabled,
    placeholderData: keepPreviousData,
  });

  return {
    ...query,
    models: query.data?.pages.flatMap((page) => page.data) ?? [],
  };
}

export function useLlmModelsByProvider(params?: LlmModelsParams) {
  const query = useLlmModels(params);

  const modelsByProvider = useMemo(() => {
    return query.data.reduce(
      (acc, model) => {
        if (!acc[model.provider]) {
          acc[model.provider] = [];
        }
        acc[model.provider].push(model);
        return acc;
      },
      {} as Record<SupportedProvider, LlmModel[]>,
    );
  }, [query.data]);

  return {
    ...query,
    modelsByProvider,
    isPlaceholderData: query.isPlaceholderData,
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
          offset: 0,
        },
      });
      return data.data[0] ?? null;
    },
    enabled: params.enabled !== false && !!params.modelId,
  });
}

export async function fetchAvailableLlmModel(params: {
  modelId: string | null | undefined;
  apiKeyId?: string | null;
  provider?: SupportedProvider;
}): Promise<LlmModel | null> {
  if (!params.modelId) return null;
  const data = await fetchLlmModelsPage({
    params: {
      apiKeyId: params.apiKeyId ?? undefined,
      provider: params.provider,
      modelId: params.modelId,
      limit: 1,
      offset: 0,
    },
  });
  return data.data[0] ?? null;
}

export async function fetchPreferredLlmModelForApiKey(params: {
  apiKeyId: string;
  bestModelId?: string | null;
  provider?: SupportedProvider;
}): Promise<LlmModel | null> {
  if (params.bestModelId) {
    const bestModel = await fetchAvailableLlmModel({
      modelId: params.bestModelId,
      apiKeyId: params.apiKeyId,
      provider: params.provider,
    });
    if (bestModel) return bestModel;
  }

  const data = await fetchLlmModelsPage({
    params: {
      apiKeyId: params.apiKeyId,
      provider: params.provider,
      limit: 1,
      offset: 0,
    },
  });
  return data.data[0] ?? null;
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

async function fetchLlmModelsPage({
  params,
}: {
  params?: LlmModelsParams;
}): Promise<LlmModelsResponse> {
  const { enabled: _enabled, ...queryParams } = params ?? {};
  const fallbackLimit = queryParams.limit ?? 50;
  const fallbackOffset = queryParams.offset ?? 0;
  const { data, error } = await getLlmModels({
    query: queryParams as GeneratedLlmModelsQuery,
  });
  if (error) {
    handleApiError(error);
  }
  const paginatedData = data as unknown as LlmModelsResponse | undefined;
  return (
    paginatedData ?? {
      data: [],
      pagination: calculatePaginationMeta(0, {
        offset: fallbackOffset,
        limit: fallbackLimit,
      }),
    }
  );
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
