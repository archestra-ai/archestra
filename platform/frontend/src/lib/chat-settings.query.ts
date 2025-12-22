import { archestraApiSdk, type archestraApiTypes } from "@shared";
import {
  useMutation,
  useQuery,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query";
import { toast } from "sonner";

export type SupportedChatProvider =
  archestraApiTypes.GetChatApiKeysResponses["200"][number]["provider"];

export type ChatApiKeyScope =
  archestraApiTypes.GetChatApiKeysResponses["200"][number]["scope"];

export type ChatApiKey =
  archestraApiTypes.GetChatApiKeysResponses["200"][number];

const {
  getChatApiKeys,
  getAvailableChatApiKeys,
  createChatApiKey,
  updateChatApiKey,
  deleteChatApiKey,
} = archestraApiSdk;

export function useChatApiKeys() {
  return useSuspenseQuery({
    queryKey: ["chat-api-keys"],
    queryFn: async () => {
      const { data, error } = await getChatApiKeys();
      if (error) {
        throw new Error(
          typeof error.error === "string"
            ? error.error
            : error.error?.message || "Failed to fetch chat API keys",
        );
      }
      return data ?? [];
    },
  });
}

export function useAvailableChatApiKeys(provider?: SupportedChatProvider) {
  return useQuery({
    queryKey: ["available-chat-api-keys", provider],
    queryFn: async () => {
      const { data, error } = await getAvailableChatApiKeys({
        query: provider ? { provider } : undefined,
      });
      if (error) {
        throw new Error(
          typeof error.error === "string"
            ? error.error
            : error.error?.message || "Failed to fetch available chat API keys",
        );
      }
      return data ?? [];
    },
  });
}

export function useCreateChatApiKey() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (data: {
      name: string;
      provider: SupportedChatProvider;
      apiKey: string;
      scope?: ChatApiKeyScope;
      teamId?: string;
    }) => {
      const { data: responseData, error } = await createChatApiKey({
        body: data,
      });
      if (error) {
        const msg =
          typeof error.error === "string"
            ? error.error
            : error.error?.message || "Failed to create API key";
        throw new Error(msg);
      }
      return responseData;
    },
    onError: (error) => {
      toast.error(error.message);
    },
    onSuccess: () => {
      toast.success("API key created successfully");
      queryClient.invalidateQueries({ queryKey: ["chat-api-keys"] });
      queryClient.invalidateQueries({ queryKey: ["available-chat-api-keys"] });
      queryClient.invalidateQueries({ queryKey: ["chat-models"] });
    },
  });
}

export function useUpdateChatApiKey() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      id,
      data,
    }: {
      id: string;
      data: {
        name?: string;
        apiKey?: string;
        scope?: ChatApiKeyScope;
        teamId?: string | null;
      };
    }) => {
      const { data: responseData, error } = await updateChatApiKey({
        path: { id },
        body: data,
      });
      if (error) {
        const msg =
          typeof error.error === "string"
            ? error.error
            : error.error?.message || "Failed to update API key";
        throw new Error(msg);
      }
      return responseData;
    },
    onError: (error) => {
      toast.error(error.message);
    },
    onSuccess: () => {
      toast.success("API key updated successfully");
      queryClient.invalidateQueries({ queryKey: ["chat-api-keys"] });
      queryClient.invalidateQueries({ queryKey: ["available-chat-api-keys"] });
    },
  });
}

export function useDeleteChatApiKey() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { data: responseData, error } = await deleteChatApiKey({
        path: { id },
      });
      if (error) {
        const msg =
          typeof error.error === "string"
            ? error.error
            : error.error?.message || "Failed to delete API key";
        throw new Error(msg);
      }
      return responseData;
    },
    onError: (error) => {
      toast.error(error.message);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["chat-api-keys"] });
      queryClient.invalidateQueries({ queryKey: ["available-chat-api-keys"] });
      queryClient.invalidateQueries({ queryKey: ["chat-models"] });
    },
  });
}
