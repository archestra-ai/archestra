import {
  archestraApiSdk,
  type archestraApiTypes,
  type SupportedProvider,
} from "@shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
import { toast } from "sonner";
import { handleApiError } from "./utils";

const { getChatModels, getModelsWithApiKeys, updateModelPricing } =
  archestraApiSdk;

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
 */
export function useChatModels() {
  return useQuery({
    queryKey: ["chat-models"],
    queryFn: async (): Promise<ChatModel[]> => {
      const { data, error } = await getChatModels();
      if (error) {
        handleApiError(error);
        return [];
      }
      return data ?? [];
    },
  });
}

/**
 * Get models grouped by provider for UI display.
 * Returns models grouped by provider with loading/error states.
 */
export function useModelsByProvider() {
  const query = useChatModels();

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
 * Update custom pricing for a model.
 * Set prices to null to reset to default pricing.
 */
export function useUpdateModelPricing() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (
      params: archestraApiTypes.UpdateModelPricingData["body"] & { id: string },
    ) => {
      const { id, ...body } = params;
      const { data, error } = await updateModelPricing({
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
      toast.success("Model pricing updated");
      queryClient.invalidateQueries({ queryKey: ["models-with-api-keys"] });
      queryClient.invalidateQueries({ queryKey: ["chat-models"] });
    },
    onError: () => {
      toast.error("Failed to update model pricing");
    },
  });
}
