import { archestraApiSdk, type archestraApiTypes } from "@shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { handleApiError } from "./utils";

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
  syncChatModels,
} = archestraApiSdk;

export function useChatApiKeys() {
  return useQuery({
    queryKey: ["chat-api-keys"],
    queryFn: async () => {
      const { data, error } = await getChatApiKeys();
      if (error) {
        handleApiError(error);
        return [];
      }
      return data ?? [];
    },
  });
}

export function useAvailableChatApiKeys(params?: {
  provider?: SupportedChatProvider;
  includeKeyId?: string | null;
}) {
  const provider = params?.provider;
  const includeKeyId = params?.includeKeyId;
  return useQuery({
    queryKey: ["available-chat-api-keys", provider, includeKeyId],
    queryFn: async () => {
      const query: { provider?: SupportedChatProvider; includeKeyId?: string } =
        {};
      if (provider) query.provider = provider;
      if (includeKeyId) query.includeKeyId = includeKeyId;
      const { data, error } = await getAvailableChatApiKeys({
        query: Object.keys(query).length > 0 ? query : undefined,
      });
      if (error) {
        handleApiError(error);
        return [];
      }
      return data ?? [];
    },
  });
}

export function useCreateChatApiKey() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (
      data: archestraApiTypes.CreateChatApiKeyData["body"],
    ) => {
      const { data: responseData, error } = await createChatApiKey({
        body: data,
      });
      if (error) {
        handleApiError(error);
        return null;
      }
      return responseData;
    },
    onSuccess: () => {
      toast.success("API key created successfully");
      queryClient.invalidateQueries({ queryKey: ["chat-api-keys"] });
      queryClient.invalidateQueries({ queryKey: ["available-chat-api-keys"] });
      queryClient.invalidateQueries({ queryKey: ["chat-models"] });
      queryClient.invalidateQueries({ queryKey: ["models-with-api-keys"] });
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
      data: archestraApiTypes.UpdateChatApiKeyData["body"];
    }) => {
      const { data: responseData, error } = await updateChatApiKey({
        path: { id },
        body: data,
      });
      if (error) {
        handleApiError(error);
        return null;
      }
      return responseData;
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
        handleApiError(error);
        return null;
      }
      return responseData;
    },
    onSuccess: () => {
      toast.success("API key deleted successfully");
      queryClient.invalidateQueries({ queryKey: ["chat-api-keys"] });
      queryClient.invalidateQueries({ queryKey: ["available-chat-api-keys"] });
      queryClient.invalidateQueries({ queryKey: ["chat-models"] });
      queryClient.invalidateQueries({ queryKey: ["models-with-api-keys"] });
    },
  });
}

export function useSyncChatModels() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const { data: responseData, error } = await syncChatModels();
      if (error) {
        handleApiError(error);
        return null;
      }
      return responseData;
    },
    onSuccess: () => {
      toast.success("Models synced");
      queryClient.invalidateQueries({ queryKey: ["chat-models"] });
      queryClient.invalidateQueries({ queryKey: ["models-with-api-keys"] });
    },
  });
}
