import {
  archestraApiSdk,
  type archestraApiTypes,
  type SupportedProvider,
} from "@shared";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";

const { getChatModels } = archestraApiSdk;

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
    queryFn: async () => {
      const { data, error } = await getChatModels();
      if (error) {
        console.error("[DEBUG chat-models] API error:", error);
        throw new Error(
          typeof error.error === "string"
            ? error.error
            : error.error?.message || "Failed to fetch chat models",
        );
      }
      return (data ?? []) as ChatModel[];
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
