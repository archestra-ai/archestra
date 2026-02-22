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
  getVirtualApiKeys,
  getAllVirtualApiKeys,
  createVirtualApiKey,
  deleteVirtualApiKey,
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
        throw error;
      }
      return responseData;
    },
    onSuccess: (data) => {
      if (!data) return;
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
        throw error;
      }
      return responseData;
    },
    onSuccess: (data) => {
      if (!data) return;
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
        throw error;
      }
      return responseData;
    },
    onSuccess: (data) => {
      if (!data) return;
      toast.success("API key deleted successfully");
      queryClient.invalidateQueries({ queryKey: ["chat-api-keys"] });
      queryClient.invalidateQueries({ queryKey: ["available-chat-api-keys"] });
      queryClient.invalidateQueries({ queryKey: ["chat-models"] });
      queryClient.invalidateQueries({ queryKey: ["models-with-api-keys"] });
    },
  });
}

export function useVirtualApiKeys(chatApiKeyId: string | null) {
  return useQuery({
    queryKey: ["virtual-api-keys", chatApiKeyId],
    queryFn: async () => {
      if (!chatApiKeyId) return [];
      const { data, error } = await getVirtualApiKeys({
        path: { chatApiKeyId },
      });
      if (error) {
        handleApiError(error);
        return [];
      }
      return data ?? [];
    },
    enabled: !!chatApiKeyId,
  });
}

export function useCreateVirtualApiKey() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      chatApiKeyId,
      data,
    }: {
      chatApiKeyId: string;
      data: archestraApiTypes.CreateVirtualApiKeyData["body"];
    }) => {
      const { data: responseData, error } = await createVirtualApiKey({
        path: { chatApiKeyId },
        body: data,
      });
      if (error) {
        handleApiError(error);
        throw error;
      }
      return responseData;
    },
    onSuccess: (_data, { chatApiKeyId }) => {
      toast.success("Virtual API key created");
      queryClient.invalidateQueries({
        queryKey: ["virtual-api-keys", chatApiKeyId],
      });
      queryClient.invalidateQueries({
        queryKey: ["all-virtual-api-keys"],
      });
    },
  });
}

export function useDeleteVirtualApiKey() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      chatApiKeyId,
      id,
    }: {
      chatApiKeyId: string;
      id: string;
    }) => {
      const { data: responseData, error } = await deleteVirtualApiKey({
        path: { chatApiKeyId, id },
      });
      if (error) {
        handleApiError(error);
        throw error;
      }
      return responseData;
    },
    onSuccess: (_data, { chatApiKeyId }) => {
      toast.success("Virtual API key deleted");
      queryClient.invalidateQueries({
        queryKey: ["virtual-api-keys", chatApiKeyId],
      });
      queryClient.invalidateQueries({
        queryKey: ["all-virtual-api-keys"],
      });
    },
  });
}

export function useAllVirtualApiKeys(params?: {
  limit?: number;
  offset?: number;
}) {
  const limit = params?.limit ?? 20;
  const offset = params?.offset ?? 0;
  return useQuery({
    queryKey: ["all-virtual-api-keys", limit, offset],
    queryFn: async () => {
      const { data, error } = await getAllVirtualApiKeys({
        query: { limit, offset },
      });
      if (error) {
        handleApiError(error);
        return {
          data: [],
          pagination: {
            currentPage: 1,
            limit,
            total: 0,
            totalPages: 0,
            hasNext: false,
            hasPrev: false,
          },
        };
      }
      return (
        data ?? {
          data: [],
          pagination: {
            currentPage: 1,
            limit,
            total: 0,
            totalPages: 0,
            hasNext: false,
            hasPrev: false,
          },
        }
      );
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
        throw error;
      }
      return responseData;
    },
    onSuccess: (data) => {
      if (!data) return;
      toast.success("Models synced");
      queryClient.invalidateQueries({ queryKey: ["chat-models"] });
      queryClient.invalidateQueries({ queryKey: ["models-with-api-keys"] });
    },
  });
}
