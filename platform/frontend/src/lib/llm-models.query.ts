import {
  archestraApiSdk,
  type archestraApiTypes,
  type SupportedProvider,
} from "@shared";
import {
  keepPreviousData,
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
type LlmModelsParams = Partial<LlmModelsQuery>;

export type LlmModel = archestraApiTypes.GetLlmModelsResponses["200"][number];
export type ModelCapabilities = NonNullable<LlmModel["capabilities"]>;
export type ModelWithApiKeys =
  archestraApiTypes.GetModelsWithApiKeysResponses["200"][number];
export type LinkedApiKey = ModelWithApiKeys["apiKeys"][number];

/**
 * Fetch available chat models from all configured providers.
 * When apiKeyId is provided, only returns models linked to that specific key.
 */
export function useLlmModels(params?: LlmModelsParams) {
  const apiKeyId = params?.apiKeyId;
  return useQuery({
    queryKey: ["llm-models", apiKeyId ?? null],
    queryFn: async (): Promise<LlmModel[]> => {
      const { data, error } = await getLlmModels({
        query: apiKeyId ? { apiKeyId } : undefined,
      });
      if (error) {
        handleApiError(error);
        return [];
      }
      return data ?? [];
    },
    // Keep showing previous models while fetching for a new apiKeyId,
    // preventing display name flicker (e.g. "Claude Opus 4.1" → raw ID → back).
    placeholderData: keepPreviousData,
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
      const { data, error } = await getLlmModels({
        query: { apiKeyId, isEmbedding: "true" },
      });
      if (error) {
        handleApiError(error);
        return [];
      }
      return data ?? [];
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
  const modelsByProvider = useMemo(() => {
    if (!query.data) return {} as Record<SupportedProvider, LlmModel[]>;
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
