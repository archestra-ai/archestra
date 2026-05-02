import {
  archestraApiSdk,
  type archestraApiTypes,
  type ResourceVisibilityScope,
  type SupportedProvider,
} from "@shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { handleApiError, toApiError } from "@/lib/utils";

export type { SupportedProvider };

export type LlmProviderApiKey =
  archestraApiTypes.GetLlmProviderApiKeysResponses["200"][number];
export type { ResourceVisibilityScope };

type LlmProviderApiKeysQuery = NonNullable<
  archestraApiTypes.GetLlmProviderApiKeysData["query"]
>;
type AvailableLlmProviderApiKeysQuery = NonNullable<
  archestraApiTypes.GetAvailableLlmProviderApiKeysData["query"]
>;
type LlmProviderApiKeysQueryParams = Partial<LlmProviderApiKeysQuery> & {
  enabled?: boolean;
};
type AvailableLlmProviderApiKeysParams =
  Partial<AvailableLlmProviderApiKeysQuery> & {
    enabled?: boolean;
  };

const {
  createLlmProviderApiKey,
  deleteLlmProviderApiKey,
  getAvailableLlmProviderApiKeys,
  getLlmProviderApiKeys,
  updateLlmProviderApiKey,
} = archestraApiSdk;

export function useLlmProviderApiKeys(params?: LlmProviderApiKeysQueryParams) {
  const search = params?.search;
  const provider = params?.provider;

  return useQuery({
    queryKey: ["llm-provider-api-keys", search, provider],
    queryFn: async () => {
      const { data, error } = await getLlmProviderApiKeys({
        query: {
          provider: provider || undefined,
          search: search || undefined,
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

export function useAvailableLlmProviderApiKeys(
  params?: AvailableLlmProviderApiKeysParams,
) {
  const provider = params?.provider;
  const includeKeyId = params?.includeKeyId;

  return useQuery({
    queryKey: ["available-llm-provider-api-keys", provider, includeKeyId],
    queryFn: async () => {
      const query: Partial<AvailableLlmProviderApiKeysQuery> = {};
      if (provider) {
        query.provider = provider;
      }
      if (includeKeyId) {
        query.includeKeyId = includeKeyId;
      }

      const { data, error } = await getAvailableLlmProviderApiKeys({
        query: Object.keys(query).length > 0 ? query : undefined,
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

export function useCreateLlmProviderApiKey() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (
      data: archestraApiTypes.CreateLlmProviderApiKeyData["body"],
    ) => {
      const { data: responseData, error } = await createLlmProviderApiKey({
        body: data,
      });
      if (error) {
        handleApiError(error);
        throw toApiError(error);
      }
      return responseData;
    },
    onSuccess: (data) => {
      if (!data) {
        return;
      }
      toast.success("API key created successfully");
      queryClient.invalidateQueries({ queryKey: ["llm-provider-api-keys"] });
      queryClient.invalidateQueries({
        queryKey: ["available-llm-provider-api-keys"],
      });
      queryClient.invalidateQueries({ queryKey: ["llm-models"] });
      queryClient.invalidateQueries({ queryKey: ["models-with-api-keys"] });
    },
  });
}

export function useUpdateLlmProviderApiKey() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      id,
      data,
    }: {
      id: string;
      data: archestraApiTypes.UpdateLlmProviderApiKeyData["body"];
    }) => {
      const { data: responseData, error } = await updateLlmProviderApiKey({
        body: data,
        path: { id },
      });
      if (error) {
        handleApiError(error);
        throw toApiError(error);
      }
      return responseData;
    },
    onSuccess: (data) => {
      if (!data) {
        return;
      }
      toast.success("API key updated successfully");
      queryClient.invalidateQueries({ queryKey: ["llm-provider-api-keys"] });
      queryClient.invalidateQueries({
        queryKey: ["available-llm-provider-api-keys"],
      });
    },
  });
}

export function useDeleteLlmProviderApiKey() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (id: string) => {
      const { data: responseData, error } = await deleteLlmProviderApiKey({
        path: { id },
      });
      if (error) {
        handleApiError(error);
        throw toApiError(error);
      }
      return responseData;
    },
    onSuccess: (data) => {
      if (!data) {
        return;
      }
      toast.success("API key deleted successfully");
      queryClient.invalidateQueries({ queryKey: ["llm-provider-api-keys"] });
      queryClient.invalidateQueries({
        queryKey: ["available-llm-provider-api-keys"],
      });
      queryClient.invalidateQueries({ queryKey: ["llm-models"] });
      queryClient.invalidateQueries({ queryKey: ["models-with-api-keys"] });
      // Conversation caches may hold the deleted key's id in chatApiKeyId,
      // which causes the chat selector to PATCH the conversation with a stale
      // id and surface a 404 "Chat API key not found". Invalidating forces
      // refetch so the auto-select uses the fresh available-keys list.
      queryClient.invalidateQueries({ queryKey: ["conversation"] });
      queryClient.invalidateQueries({ queryKey: ["conversations"] });
    },
  });
}
