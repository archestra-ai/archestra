import {
  archestraApiSdk,
  type archestraApiTypes,
  type SupportedProvider,
} from "@shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { handleApiError, toApiError } from "./utils";

export type { SupportedProvider };

export type ChatApiKeyScope =
  archestraApiTypes.GetChatApiKeysResponses["200"][number]["scope"];

export type ChatApiKey =
  archestraApiTypes.GetChatApiKeysResponses["200"][number];

type ChatApiKeysQuery = NonNullable<
  archestraApiTypes.GetChatApiKeysData["query"]
>;
type AvailableChatApiKeysQuery = NonNullable<
  archestraApiTypes.GetAvailableChatApiKeysData["query"]
>;
type AllVirtualApiKeysQuery = NonNullable<
  archestraApiTypes.GetAllVirtualApiKeysData["query"]
>;
type ChatApiKeysQueryParams = Partial<ChatApiKeysQuery> & { enabled?: boolean };
type AvailableChatApiKeysParams = Partial<AvailableChatApiKeysQuery>;

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

export function useChatApiKeys(params?: ChatApiKeysQueryParams) {
  const search = params?.search;
  const provider = params?.provider;
  return useQuery({
    queryKey: ["chat-api-keys", search, provider],
    queryFn: async () => {
      const { data, error } = await getChatApiKeys({
        query: {
          search: search || undefined,
          provider: provider || undefined,
        },
      });
      if (error) {
        handleApiError(error);
        return [];
      }
      return data ?? [];
    },
    enabled: params?.enabled,
  });
}

export function useAvailableChatApiKeys(params?: AvailableChatApiKeysParams) {
  const provider = params?.provider;
  const includeKeyId = params?.includeKeyId;
  return useQuery({
    queryKey: ["available-chat-api-keys", provider, includeKeyId],
    queryFn: async () => {
      const query: Partial<AvailableChatApiKeysQuery> = {};
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
        throw toApiError(error);
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
        throw toApiError(error);
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
        throw toApiError(error);
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
        throw toApiError(error);
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
        throw toApiError(error);
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

export function useAllVirtualApiKeys(params?: Partial<AllVirtualApiKeysQuery>) {
  const limit = params?.limit ?? 20;
  const offset = params?.offset ?? 0;
  const search = params?.search;
  const chatApiKeyId = params?.chatApiKeyId;
  return useQuery({
    queryKey: ["all-virtual-api-keys", limit, offset, search, chatApiKeyId],
    queryFn: async () => {
      const { data, error } = await getAllVirtualApiKeys({
        query: {
          limit,
          offset,
          search: search || undefined,
          chatApiKeyId: chatApiKeyId || undefined,
        },
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
        throw toApiError(error);
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
