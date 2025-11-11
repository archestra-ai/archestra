import { archestraApiSdk, type archestraApiTypes } from "@shared";
import {
  useMutation,
  useQuery,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query";

const { getChatSettings, updateChatSettings, getChatModels } = archestraApiSdk;

export function useChatSettings(params?: {
  initialData?: archestraApiTypes.GetChatSettingsResponses["200"];
}) {
  return useSuspenseQuery({
    queryKey: ["chat-settings"],
    queryFn: async () => (await getChatSettings()).data ?? null,
    initialData: params?.initialData,
  });
}

export function useChatSettingsOptional() {
  return useQuery({
    queryKey: ["chat-settings"],
    queryFn: async () => (await getChatSettings()).data ?? null,
  });
}

export function useUpdateChatSettings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (data: {
      provider?: "anthropic" | "openai";
      model?: string;
      anthropicApiKey?: string;
      openaiApiKey?: string;
      resetAnthropicApiKey?: boolean;
      resetOpenaiApiKey?: boolean;
    }) => {
      const response = await updateChatSettings({ body: data });
      return response.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["chat-settings"] });
      queryClient.invalidateQueries({ queryKey: ["chat-models"] });
    },
  });
}

export function useChatModels(provider?: "anthropic" | "openai" | undefined) {
  return useQuery({
    queryKey: ["chat-models", provider],
    queryFn: async () => {
      if (!provider) return null;
      const response = await getChatModels({
        query: { provider },
      });
      return response.data;
    },
    retry: false,
    enabled: !!provider,
  });
}
