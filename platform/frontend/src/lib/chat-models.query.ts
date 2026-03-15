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
import { handleApiError } from "./utils";

const { getChatModels, getModelsWithApiKeys, updateModel } = archestraApiSdk;
type ChatModelsQuery = NonNullable<
  archestraApiTypes.GetChatModelsData["query"]
>;
type ChatModelsParams = Partial<ChatModelsQuery>;

/**
 * Chat model type from the API response.
 * Uses the generated API types for type safety.
 */
export type ChatModel = archestraApiTypes.GetChatModelsResponses["200"][number];

/**
 * Model capabilities type extracted from ChatModel.
 */
export type ModelCapabilities = NonNullable<ChatModel["capabilities"]>;

/**
 * Fetch available chat models from all configured providers.
 * When apiKeyId is provided, only returns models linked to that specific key.
 */
export function useChatModels(params?: ChatModelsParams) {
  const apiKeyId = params?.apiKeyId;
  return useQuery({
    queryKey: ["chat-models", apiKeyId ?? null],
    queryFn: async (): Promise<ChatModel[]> => {
      const { data, error } = await getChatModels({
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
 * Get models grouped by provider for UI display.
 * Returns models grouped by provider with loading/error states.
 * When apiKeyId is provided, only returns models linked to that specific key.
 */
export function useModelsByProvider(params?: ChatModelsParams) {
  const query = useChatModels(params);

  // Memoize to prevent creating new object reference on every render
  const modelsByProvider = useMemo(() => {
    if (!query.data) return {} as Record<SupportedProvider, ChatModel[]>;
    return query.data.reduce(
      (acc, model) => {
        if (!acc[model.provider]) {
          acc[model.provider] = [];
        }
        acc[model.provider].push(model);
        return acc;
      },
      {} as Record<SupportedProvider, ChatModel[]>,
    );
  }, [query.data]);

  return {
    ...query,
    modelsByProvider,
    isPlaceholderData: query.isPlaceholderData,
  };
}

/**
 * Model with API keys type from the API response.
 */
export type ModelWithApiKeys =
  archestraApiTypes.GetModelsWithApiKeysResponses["200"][number];

/**
 * Linked API key type extracted from ModelWithApiKeys.
 */
export type LinkedApiKey = ModelWithApiKeys["apiKeys"][number];

/**
 * Fetch all models with their linked API keys.
 * Used for the settings page models table.
 */
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
      queryClient.invalidateQueries({ queryKey: ["chat-models"] });
    },
    onError: () => {
      toast.error("Failed to update model");
    },
  });
}
