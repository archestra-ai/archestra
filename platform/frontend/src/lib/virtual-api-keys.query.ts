import { archestraApiSdk, type archestraApiTypes } from "@shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { handleApiError, toApiError } from "@/lib/utils";

type AllVirtualApiKeysQuery = NonNullable<
  archestraApiTypes.GetAllVirtualApiKeysData["query"]
>;

const {
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
      const { data, error } = await getAllVirtualApiKeys({
        query: {
          chatApiKeyId,
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
      chatApiKeyId: string | null;
      data: archestraApiTypes.CreateVirtualApiKeyData["body"];
    }) => {
      const { data: responseData, error } = await createVirtualApiKey({
        body: {
          ...data,
          chatApiKeyId,
        },
      });
      if (error) {
        handleApiError(error);
        throw toApiError(error);
      }
      return responseData;
    },
    onSuccess: (_data, { chatApiKeyId }) => {
      toast.success("Virtual API key created");
      if (chatApiKeyId) {
        queryClient.invalidateQueries({
          queryKey: ["virtual-api-keys", chatApiKeyId],
        });
      }
      queryClient.invalidateQueries({
        queryKey: ["all-virtual-api-keys"],
      });
    },
  });
}

export function useDeleteVirtualApiKey() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id }: { chatApiKeyId: string | null; id: string }) => {
      const { data: responseData, error } = await deleteVirtualApiKey({
        path: { id },
      });
      if (error) {
        handleApiError(error);
        throw toApiError(error);
      }
      return responseData;
    },
    onSuccess: (_data, { chatApiKeyId }) => {
      toast.success("Virtual API key deleted");
      if (chatApiKeyId) {
        queryClient.invalidateQueries({
          queryKey: ["virtual-api-keys", chatApiKeyId],
        });
      }
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
      id,
      data,
    }: {
      chatApiKeyId: string | null;
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
    onSuccess: (_data, { chatApiKeyId }) => {
      toast.success("Virtual API key updated");
      if (chatApiKeyId) {
        queryClient.invalidateQueries({
          queryKey: ["virtual-api-keys", chatApiKeyId],
        });
      }
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
