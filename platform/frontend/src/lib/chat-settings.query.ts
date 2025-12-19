import { archestraApiSdk, type archestraApiTypes } from "@shared";
import {
  useMutation,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query";

type SupportedChatProvider =
  archestraApiTypes.GetChatApiKeysResponses["200"][number]["provider"];

const {
  getChatApiKeys,
  createChatApiKey,
  updateChatApiKey,
  deleteChatApiKey,
  setChatApiKeyDefault,
  unsetChatApiKeyDefault,
  updateChatApiKeyProfiles,
  bulkAssignChatApiKeysToProfiles,
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

export function useCreateChatApiKey() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (data: {
      name: string;
      provider: SupportedChatProvider;
      apiKey: string;
      isOrganizationDefault?: boolean;
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
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["chat-api-keys"] });
      // Invalidate chat models so the model picker refetches available models
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
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["chat-api-keys"] });
      // Invalidate chat models so the model picker refetches available models
      queryClient.invalidateQueries({ queryKey: ["chat-models"] });
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
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["chat-api-keys"] });
      // Invalidate chat models so the model picker refetches available models
      queryClient.invalidateQueries({ queryKey: ["chat-models"] });
    },
  });
}

export function useSetChatApiKeyDefault() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { data: responseData, error } = await setChatApiKeyDefault({
        path: { id },
      });
      if (error) {
        const msg =
          typeof error.error === "string"
            ? error.error
            : error.error?.message || "Failed to set API key as default";
        throw new Error(msg);
      }
      return responseData;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["chat-api-keys"] });
    },
  });
}

export function useUnsetChatApiKeyDefault() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { data: responseData, error } = await unsetChatApiKeyDefault({
        path: { id },
      });
      if (error) {
        const msg =
          typeof error.error === "string"
            ? error.error
            : error.error?.message || "Failed to unset API key as default";
        throw new Error(msg);
      }
      return responseData;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["chat-api-keys"] });
    },
  });
}

export function useUpdateChatApiKeyProfiles() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      id,
      profileIds,
    }: {
      id: string;
      profileIds: string[];
    }) => {
      const { data: responseData, error } = await updateChatApiKeyProfiles({
        path: { id },
        body: { profileIds },
      });
      if (error) {
        const msg =
          typeof error.error === "string"
            ? error.error
            : error.error?.message || "Failed to update API key profiles";
        throw new Error(msg);
      }
      return responseData;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["chat-api-keys"] });
    },
  });
}

export function useBulkAssignChatApiKeysToProfiles() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      chatApiKeyIds,
      profileIds,
    }: {
      chatApiKeyIds: string[];
      profileIds: string[];
    }) => {
      const { data: responseData, error } =
        await bulkAssignChatApiKeysToProfiles({
          body: { chatApiKeyIds, profileIds },
        });
      if (error) {
        const msg =
          typeof error.error === "string"
            ? error.error
            : error.error?.message || "Failed to bulk assign API keys";
        throw new Error(msg);
      }
      return responseData;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["chat-api-keys"] });
    },
  });
}
