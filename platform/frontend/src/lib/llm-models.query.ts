import {
  archestraApiSdk,
  type archestraApiTypes,
  type SupportedProvider,
} from "@archestra/shared";
import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useMemo } from "react";
import { toast } from "sonner";
import { toBulkOutcome } from "@/lib/bulk-action";
import {
  BOOTSTRAP_QUERY_RETRY,
  PERSISTED_QUERY_META,
} from "@/lib/query-persistence";
import { handleApiError, throwOnApiError } from "@/lib/utils/api";

const {
  getLlmModels,
  getModelsWithApiKeys,
  updateModel,
  syncLlmModels,
  bulkUpdateModels,
} = archestraApiSdk;
type LlmModelsQuery = NonNullable<archestraApiTypes.GetLlmModelsData["query"]>;
type LlmModelsParams = Partial<LlmModelsQuery> & {
  enabled?: boolean;
};

export type LlmModel = archestraApiTypes.GetLlmModelsResponses["200"][number];
export type ModelCapabilities = NonNullable<LlmModel["capabilities"]>;
export type ModelWithApiKeys =
  archestraApiTypes.GetModelsWithApiKeysResponses["200"][number];
export type LinkedApiKey = ModelWithApiKeys["apiKeys"][number];

/**
 * Fetch available chat models from all configured providers.
 * When apiKeyId is provided, only returns models linked to that specific key.
 */
export function useLlmModels(params?: LlmModelsParams) {
  const apiKeyId = params?.apiKeyId;
  return useQuery({
    queryKey: ["llm-models", apiKeyId ?? null],
    queryFn: async (): Promise<LlmModel[]> => {
      const { data, error } = await getLlmModels({
        query: apiKeyId ? { apiKeyId } : undefined,
      });
      throwOnApiError(error);
      return data ?? [];
    },
    // Keep showing previous models while fetching for a new apiKeyId,
    // preventing display name flicker (e.g. "Claude Opus 4.1" → raw ID → back).
    placeholderData: keepPreviousData,
    enabled: params?.enabled,
    // The new-chat composer resolves its default model from this catalog.
    // Recover from a transient fetch failure rather than latching an empty
    // catalog into "Select model" (T-1317).
    retry: BOOTSTRAP_QUERY_RETRY,
    // The model list is small, contains no credentials, and is required to
    // replace the new-chat composer's loading placeholder with the saved model.
    // Restoring it makes a refresh immediately usable while revalidation runs.
    meta: PERSISTED_QUERY_META,
  });
}

/**
 * The display name (e.g. "Claude Sonnet") for a chat model's database id, or
 * null when it can't be resolved (deleted model, network failure). A plain
 * one-off fetch rather than the `useLlmModels` hook — for callers outside a
 * component render, like stamping the model onto a recording bundle at save
 * time.
 */
export async function resolveModelDisplayName(
  modelId: string,
): Promise<string | null> {
  try {
    const { data, error } = await getLlmModels({});
    if (error || !data) return null;
    return data.find((model) => model.dbId === modelId)?.displayName ?? null;
  } catch {
    return null;
  }
}

/**
 * Fetch embedding models for a specific API key.
 * Returns only models with configured embedding dimensions for the given API key.
 */
export function useEmbeddingModels(apiKeyId: string | null) {
  return useQuery({
    queryKey: ["llm-models", "embedding", apiKeyId],
    queryFn: async (): Promise<LlmModel[]> => {
      if (!apiKeyId) return [];
      const { data, error } = await getLlmModels({
        query: { apiKeyId, isEmbedding: "true" },
      });
      throwOnApiError(error);
      return data ?? [];
    },
    enabled: !!apiKeyId,
    placeholderData: keepPreviousData,
  });
}

/**
 * Get models grouped by provider for UI display.
 * Returns models grouped by provider with loading/error states.
 * When apiKeyId is provided, only returns models linked to that specific key.
 */
export function useLlmModelsByProvider(params?: LlmModelsParams) {
  const query = useLlmModels(params);

  // Memoize to prevent creating new object reference on every render
  const modelsByProvider = useMemo(() => {
    if (!query.data) return {} as Record<SupportedProvider, LlmModel[]>;
    return query.data.reduce(
      (acc, model) => {
        if (!acc[model.provider]) {
          acc[model.provider] = [];
        }
        acc[model.provider].push(model);
        return acc;
      },
      {} as Record<SupportedProvider, LlmModel[]>,
    );
  }, [query.data]);

  return {
    ...query,
    modelsByProvider,
    isPlaceholderData: query.isPlaceholderData,
  };
}

export function useModelsWithApiKeys(options?: {
  toastOnError?: boolean;
  enabled?: boolean;
  /** The models page's access filters; models have no owner. */
  access?: NonNullable<
    archestraApiTypes.GetModelsWithApiKeysData["query"]
  >["access"];
  sharedWith?: string[];
}) {
  const toastOnError = options?.toastOnError;
  const access = options?.access;
  const sharedWith = options?.sharedWith;
  return useQuery({
    queryKey:
      access || sharedWith
        ? ["models-with-api-keys", { access, sharedWith }]
        : ["models-with-api-keys"],
    enabled: options?.enabled,
    queryFn: async (): Promise<ModelWithApiKeys[]> => {
      const { data, error } = await getModelsWithApiKeys({
        query: { access, sharedWith },
      });
      throwOnApiError(error, { toastOnError });
      return data ?? [];
    },
  });
}

/**
 * Update model details (pricing + modalities).
 * Set prices to null to reset to default pricing.
 */
/**
 * Hides or shows a selection of models at once — the models table's bulk
 * action. One request, bypassing `useUpdateModel` so a batch reports once
 * rather than per row.
 */
export function useBulkUpdateModelVisibility() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      models,
      ignored,
    }: {
      models: readonly { id: string; modelId: string }[];
      ignored: boolean;
    }) =>
      bulkUpdateModels({
        body: { ids: models.map((model) => model.id), ignored },
      }).then(({ data, error }) => {
        throwOnApiError(error, { toastOnError: false });
        return toBulkOutcome(data ?? { succeeded: [], failed: [] });
      }),
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ["models-with-api-keys"] });
      queryClient.invalidateQueries({ queryKey: ["llm-models"] });
    },
  });
}

export function useUpdateModel() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (
      params: archestraApiTypes.UpdateModelData["body"] & { id: string },
    ) => {
      const { id, ...body } = params;
      const { data, error } = await updateModel({
        path: { id },
        body,
      });
      if (error) {
        handleApiError(error);
        return null;
      }
      return data;
    },
    onSuccess: (data) => {
      // `mutationFn` returns null rather than throwing on error (callers await
      // `mutateAsync` and branch on the result), so TanStack Query still treats
      // a failed PATCH as a success. Without this guard the user sees "Model
      // updated" beside the error toast and the caches are invalidated as if
      // the write landed — the save looks applied until the dialog is reopened.
      if (!data) return;
      toast.success("Model updated");
      queryClient.invalidateQueries({ queryKey: ["models-with-api-keys"] });
      queryClient.invalidateQueries({ queryKey: ["llm-models"] });
    },
    onError: () => {
      toast.error("Failed to update model");
    },
  });
}

export function useSyncLlmModels() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const { data: responseData, error } = await syncLlmModels();
      if (error) {
        handleApiError(error);
        throw error;
      }
      return responseData;
    },
    onSuccess: (data) => {
      if (!data) return;
      if (data.success) {
        toast.success("Models refreshed");
      } else {
        toast.error("Some models could not be refreshed", {
          description: data.failures
            .map(
              (failure) =>
                `${failure.name}: ${failure.requiresReauthentication ? "reconnect required" : "refresh failed; try again"}`,
            )
            .join("; "),
        });
      }
      queryClient.invalidateQueries({ queryKey: ["llm-provider-api-keys"] });
      queryClient.invalidateQueries({ queryKey: ["llm-models"] });
      queryClient.invalidateQueries({ queryKey: ["models-with-api-keys"] });
    },
  });
}
