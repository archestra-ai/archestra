import { archestraApiSdk, type archestraApiTypes } from "@shared";
import {
  useMutation,
  useQuery,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query";

const { getChatSettings, updateChatSettings } = archestraApiSdk;

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
      anthropicApiKey?: string;
      resetApiKey?: boolean;
    }) => {
      const response = await updateChatSettings({ body: data });
      return response.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["chat-settings"] });
    },
  });
}
