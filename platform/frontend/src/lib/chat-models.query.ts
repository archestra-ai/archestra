import { archestraApiSdk, type SupportedProvider } from "@shared";
import { useQuery, useSuspenseQuery } from "@tanstack/react-query";

const { getChatModels } = archestraApiSdk;

export interface ChatModel {
  id: string;
  displayName: string;
  provider: SupportedProvider;
  createdAt?: string;
}

/**
 * Fetch available chat models from all configured providers.
 * Models are cached server-side for 12 hours.
 */
export function useChatModels() {
  return useSuspenseQuery({
    queryKey: ["chat-models"],
    queryFn: async () => {
      const { data, error } = await getChatModels();
      if (error) {
        throw new Error(
          typeof error.error === "string"
            ? error.error
            : error.error?.message || "Failed to fetch chat models",
        );
      }
      return (data ?? []) as ChatModel[];
    },
    // Frontend cache for 5 minutes (server caches for 12 hours)
    staleTime: 5 * 60 * 1000,
  });
}

/**
 * Get models grouped by provider for UI display.
 * Uses Suspense - must be used within a Suspense boundary.
 */
export function useModelsByProvider() {
  const query = useChatModels();

  const modelsByProvider = query.data.reduce(
    (acc, model) => {
      if (!acc[model.provider]) {
        acc[model.provider] = [];
      }
      acc[model.provider].push(model);
      return acc;
    },
    {} as Record<SupportedProvider, ChatModel[]>,
  );

  return {
    ...query,
    modelsByProvider,
  };
}

/**
 * Non-suspense version for fetching chat models.
 * Use in components without Suspense boundaries.
 */
export function useChatModelsQuery() {
  return useQuery({
    queryKey: ["chat-models"],
    queryFn: async () => {
      const { data, error } = await getChatModels();
      if (error) {
        throw new Error(
          typeof error.error === "string"
            ? error.error
            : error.error?.message || "Failed to fetch chat models",
        );
      }
      return (data ?? []) as ChatModel[];
    },
    staleTime: 5 * 60 * 1000,
  });
}
