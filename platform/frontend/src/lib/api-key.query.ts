import { archestraApiSdk, type archestraApiTypes } from "@archestra/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { toBulkOutcome } from "@/lib/bulk-action";
import { handleApiError, throwOnApiError, toApiError } from "./utils";

export type UserApiKey = archestraApiTypes.GetApiKeysResponses["200"][number];

const { getApiKeys, createApiKey, deleteApiKey, bulkDeleteApiKeys } =
  archestraApiSdk;

export function useApiKeys() {
  const { data: canReadApiKeys } = useHasPermissions({ apiKey: ["read"] });

  return useQuery({
    queryKey: ["api-keys"],
    queryFn: async () => {
      const { data, error } = await getApiKeys();
      throwOnApiError(error, { toastOnError: false });

      return data ?? [];
    },
    enabled: !!canReadApiKeys,
  });
}

export function useCreateApiKey() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (body: archestraApiTypes.CreateApiKeyData["body"]) => {
      const { data, error } = await createApiKey({ body });
      if (error) {
        handleApiError(error);
        throw toApiError(error);
      }

      return data;
    },
    onSuccess: (data) => {
      if (!data) return;
      toast.success("API key created successfully");
      queryClient.invalidateQueries({ queryKey: ["api-keys"] });
    },
  });
}

/**
 * Deletes a selection of API keys in one request, bypassing `useDeleteApiKey`
 * so a batch reports once rather than per key.
 */
export function useBulkDeleteApiKeys() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (keys: readonly { id: string; name: string }[]) =>
      bulkDeleteApiKeys({
        body: { ids: keys.map((key) => key.id) },
      }).then(({ data, error }) => {
        throwOnApiError(error, { toastOnError: false });
        return toBulkOutcome(data ?? { succeeded: [], failed: [] });
      }),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["api-keys"] }),
  });
}

export function useDeleteApiKey() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (id: string) => {
      const { data, error } = await deleteApiKey({ path: { id } });
      if (error) {
        handleApiError(error);
        throw toApiError(error);
      }

      return data;
    },
    onSuccess: (data) => {
      if (!data) return;
      toast.success("API key deleted successfully");
      queryClient.invalidateQueries({ queryKey: ["api-keys"] });
    },
  });
}
