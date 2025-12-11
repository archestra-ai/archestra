import { archestraApiSdk, type archestraApiTypes } from "@shared";
import {
  useMutation,
  useQuery,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query";

const {
  getChatSettings,
  updateChatSettings,
  getChatApiKeys,
  createChatApiKey,
  updateChatApiKey,
  deleteChatApiKey,
  setChatApiKeyDefault,
  unsetChatApiKeyDefault,
  updateChatApiKeyProfiles,
} = archestraApiSdk;

// Legacy chat settings hooks (for backward compatibility)
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
      /** External Vault path for BYOS */
      externalVaultSecret?: string;
    }) => {
      const { data: responseData, error } = await updateChatSettings({
        body: data,
      });
      if (error) {
        const msg =
          typeof error.error === "string"
            ? error.error
            : error.error?.message || "Unknown error";
        throw new Error(msg);
      }
      return responseData;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["chat-settings"] });
    },
  });
}

// New chat API keys hooks
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

export function useChatApiKeysOptional() {
  return useQuery({
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
      provider: "anthropic" | "openai";
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
