import { archestraApiSdk, type archestraApiTypes } from "@shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { handleApiError, toApiError } from "@/lib/utils";

type AllVirtualApiKeysQuery = NonNullable<
  archestraApiTypes.GetAllVirtualApiKeysData["query"]
>;
type AllVirtualApiKeysParams = Partial<AllVirtualApiKeysQuery> & {
  enabled?: boolean;
};

const {
  getAllVirtualApiKeys,
  createVirtualApiKey,
  updateVirtualApiKey,
  deleteVirtualApiKey,
} = archestraApiSdk;

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
      if (error) {
        handleApiError(error);
        return [];
      }
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
  return useQuery({
    queryKey: ["all-virtual-api-keys", limit, offset, search, providerApiKeyId],
    queryFn: async () => {
      const { data, error } = await getAllVirtualApiKeys({
        query: {
          limit,
          offset,
          search: search || undefined,
          providerApiKeyId: providerApiKeyId || undefined,
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
    enabled: params?.enabled,
  });
}
