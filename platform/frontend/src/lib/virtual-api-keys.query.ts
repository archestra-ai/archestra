import { archestraApiSdk, type archestraApiTypes } from "@shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { handleApiError, toApiError } from "@/lib/utils";

type AllVirtualApiKeysQuery = NonNullable<
  archestraApiTypes.GetAllVirtualApiKeysData["query"]
>;

const {
  getVirtualApiKeys,
  getAllVirtualApiKeys,
  createVirtualApiKey,
  updateVirtualApiKey,
  deleteVirtualApiKey,
} = archestraApiSdk;

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

export function useUpdateVirtualApiKey() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      chatApiKeyId,
      id,
      data,
    }: {
      chatApiKeyId: string;
      id: string;
      data: archestraApiTypes.UpdateVirtualApiKeyData["body"];
    }) => {
      const { data: responseData, error } = await updateVirtualApiKey({
        path: { chatApiKeyId, id },
        body: data,
      });
      if (error) {
        handleApiError(error);
        throw toApiError(error);
      }
      return responseData;
    },
    onSuccess: (_data, { chatApiKeyId }) => {
      toast.success("Virtual API key updated");
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
