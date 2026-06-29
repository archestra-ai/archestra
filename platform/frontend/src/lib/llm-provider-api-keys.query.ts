import {
  archestraApiSdk,
  type archestraApiTypes,
  type ResourceVisibilityScope,
  type SupportedProvider,
} from "@archestra/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { handleApiError, throwOnApiError, toApiError } from "@/lib/utils";

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
  /**
   * Toast on fetch failure. Default true so list/dialog callers fail loud.
   * Callers that render their own error state (the new-chat and projects
   * gates) pass false to avoid a redundant toast-plus-screen and a fresh
   * toast on every retry. The query throws regardless, so `isError` is always
   * available to branch on.
   *
   * Best-effort under react-query's shared fetches: observers with the same
   * query key share one request, so the toast follows whichever observer
   * triggers the fetch (e.g. a gating screen's own retry uses its `false`).
   * The gating screens don't rely on suppression for correctness — they show
   * their inline error from `isError` either way.
   */
  toastOnError?: boolean;
};
type AvailableLlmProviderApiKeysParams =
  Partial<AvailableLlmProviderApiKeysQuery> & {
    enabled?: boolean;
    toastOnError?: boolean;
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
  const toastOnError = params?.toastOnError ?? true;

  return useQuery({
    queryKey: ["llm-provider-api-keys", search, provider],
    queryFn: async () => {
      const { data, error } = await getLlmProviderApiKeys({
        query: {
          provider: provider || undefined,
          search: search || undefined,
        },
      });
      throwOnApiError(error, { toastOnError });
      return data ?? [];
    },
    enabled: params?.enabled,
  });
}

/**
 * Whether the user has any usable LLM provider key — the same check the new
 * chat screen uses to choose between the composer and the "Add an LLM Provider
 * Key" prompt. System keys for keyless providers (Vertex AI Gemini, vLLM,
 * Ollama) count, since they surface as keys here. Gated on the read permissions
 * the underlying query needs, so a user lacking them doesn't trigger a 403.
 */
export function useHasAnyApiKey(): {
  hasAnyApiKey: boolean;
  isLoading: boolean;
  isLoadError: boolean;
  refetch: () => void;
} {
  const { data: canReadKeys } = useHasPermissions({
    llmProviderApiKey: ["read"],
  });
  const { data: canReadModels } = useHasPermissions({ llmModel: ["read"] });
  const enabled = canReadKeys === true && canReadModels === true;
  const {
    data: keys = [],
    isLoading,
    isLoadingError,
    refetch,
  } = useLlmProviderApiKeys({ enabled, toastOnError: false });
  const permissionsResolving =
    canReadKeys === undefined || canReadModels === undefined;
  return {
    hasAnyApiKey: keys.length > 0,
    isLoading: permissionsResolving || (enabled && isLoading),
    // Only the first-fetch failure (no cached list). A failed background
    // refetch keeps the last successful result — empty or not — so we don't
    // hide a known "no keys" or working state behind the load-error screen.
    isLoadError: enabled && isLoadingError,
    refetch: () => {
      void refetch();
    },
  };
}

export function useAvailableLlmProviderApiKeys(
  params?: AvailableLlmProviderApiKeysParams,
) {
  const provider = params?.provider;
  const includeKeyId = params?.includeKeyId;
  const toastOnError = params?.toastOnError;

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
      throwOnApiError(error, { toastOnError });
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
    },
  });
}
