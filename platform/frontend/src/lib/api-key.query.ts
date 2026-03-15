import { archestraApiSdk, type archestraApiTypes } from "@shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useHasPermissions } from "./auth.query";
import { handleApiError, toApiError } from "./utils";

export type UserApiKey = archestraApiTypes.GetApiKeysResponses["200"][number];

const { getApiKeys, createApiKey, deleteApiKey } = archestraApiSdk;

export function useApiKeys() {
  const { data: canReadApiKeys } = useHasPermissions({ apiKey: ["read"] });

  return useQuery({
    queryKey: ["api-keys"],
    queryFn: async () => {
      const { data, error } = await getApiKeys();
      if (error) {
        handleApiError(error);
        return [];
      }

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
