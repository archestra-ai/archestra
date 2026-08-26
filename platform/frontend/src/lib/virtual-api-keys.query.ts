import { archestraApiSdk, type archestraApiTypes } from "@archestra/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { toBulkOutcome } from "@/lib/bulk-action";
import { handleApiError, throwOnApiError, toApiError } from "@/lib/utils";

type AllVirtualApiKeysQuery = NonNullable<
  archestraApiTypes.GetAllVirtualApiKeysData["query"]
>;
type AllVirtualApiKeysParams = Partial<AllVirtualApiKeysQuery> & {
  enabled?: boolean;
  toastOnError?: boolean;
};

const {
  getAllVirtualApiKeys,
  getVirtualApiKey,
  getVirtualApiKeyValue,
  createVirtualApiKey,
  updateVirtualApiKey,
  deleteVirtualApiKey,
  bulkDeleteVirtualApiKeys,
} = archestraApiSdk;

/**
 * Fetch a virtual key's raw value on demand (reveal/copy). Author-only —
 * the backend 403s for keys created by someone else.
 */
export function useFetchVirtualApiKeyValue() {
  return useMutation({
    mutationFn: async (id: string) => {
      const { data, error } = await getVirtualApiKeyValue({ path: { id } });
      if (error) {
        handleApiError(error);
        return null;
      }
      return data?.value ?? null;
    },
  });
}

export function useVirtualApiKeys(providerApiKeyId: string | null) {
  return useQuery({
    queryKey: ["virtual-api-keys", providerApiKeyId],
    queryFn: async () => {
      if (!providerApiKeyId) return [];
      const { data, error } = await getAllVirtualApiKeys({
        query: {
          providerApiKeyId,
          limit: 100,
          offset: 0,
        },
      });
      throwOnApiError(error);
      return data?.data ?? [];
    },
    enabled: !!providerApiKeyId,
  });
}

export function useCreateVirtualApiKey() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      data,
    }: {
      data: archestraApiTypes.CreateVirtualApiKeyData["body"];
    }) => {
      const { data: responseData, error } = await createVirtualApiKey({
        body: data,
      });
      if (error) {
        handleApiError(error);
        throw toApiError(error);
      }
      return responseData;
    },
    onSuccess: () => {
      toast.success("Virtual API key created");
      queryClient.invalidateQueries({
        queryKey: ["all-virtual-api-keys"],
      });
      queryClient.invalidateQueries({
        queryKey: ["virtual-api-keys"],
      });
    },
  });
}

export function useDeleteVirtualApiKey() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id }: { id: string }) => {
      const { data: responseData, error } = await deleteVirtualApiKey({
        path: { id },
      });
      if (error) {
        handleApiError(error);
        throw toApiError(error);
      }
      return responseData;
    },
    onSuccess: () => {
      toast.success("Virtual API key deleted");
      queryClient.invalidateQueries({
        queryKey: ["all-virtual-api-keys"],
      });
      queryClient.invalidateQueries({
        queryKey: ["virtual-api-keys"],
      });
    },
  });
}

export function useUpdateVirtualApiKey() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      id,
      data,
    }: {
      id: string;
      data: archestraApiTypes.UpdateVirtualApiKeyData["body"];
    }) => {
      const { data: responseData, error } = await updateVirtualApiKey({
        path: { id },
        body: data,
      });
      if (error) {
        handleApiError(error);
        throw toApiError(error);
      }
      return responseData;
    },
    onSuccess: () => {
      toast.success("Virtual API key updated");
      queryClient.invalidateQueries({
        queryKey: ["all-virtual-api-keys"],
      });
      queryClient.invalidateQueries({
        queryKey: ["virtual-api-keys"],
      });
    },
  });
}

export function useAllVirtualApiKeys(params?: AllVirtualApiKeysParams) {
  const limit = params?.limit ?? 20;
  const offset = params?.offset ?? 0;
  const search = params?.search;
  const providerApiKeyId = params?.providerApiKeyId;
  const keyType = params?.keyType;
  const scope = params?.scope;
  const toastOnError = params?.toastOnError;
  return useQuery({
    queryKey: [
      "all-virtual-api-keys",
      limit,
      offset,
      search,
      providerApiKeyId,
      keyType,
      scope,
    ],
    queryFn: async () => {
      const { data, error } = await getAllVirtualApiKeys({
        query: {
          limit,
          offset,
          search: search || undefined,
          providerApiKeyId: providerApiKeyId || undefined,
          keyType: keyType || undefined,
          scope: scope || undefined,
        },
      });
      throwOnApiError(error, { toastOnError });
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
    enabled: params?.enabled,
  });
}

/**
 * Deletes a selection of virtual keys in one request. The caller reports the
 * batch once via `reportBulkOutcome` rather than a toast per row.
 */
export function useBulkDeleteVirtualApiKeys() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (keys: readonly { id: string }[]) =>
      bulkDeleteVirtualApiKeys({
        body: { ids: keys.map((key) => key.id) },
      }).then(({ data, error }) => {
        throwOnApiError(error, { toastOnError: false });
        return toBulkOutcome(data ?? { succeeded: [], failed: [] });
      }),
    // Settled rather than success: a partly applied batch still moved rows.
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ["all-virtual-api-keys"] });
      queryClient.invalidateQueries({ queryKey: ["virtual-api-keys"] });
    },
  });
}

export function useVirtualKey(id: string | undefined) {
  return useQuery({
    queryKey: ["virtual-api-keys", "detail", id],
    queryFn: async () => {
      if (!id) return null;
      const { data, error } = await getVirtualApiKey({ path: { id } });
      throwOnApiError(error, { allowNotFound: true, toastOnError: false });
      return data ?? null;
    },
    enabled: !!id,
  });
}
