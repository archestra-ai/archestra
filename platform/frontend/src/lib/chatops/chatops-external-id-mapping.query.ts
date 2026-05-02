import { archestraApiClient } from "@shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { handleApiError } from "@/lib/utils";

export type ExternalIdMapping = {
  id: string;
  adapterId: string;
  externalId: string;
  userId: string;
  createdAt: string;
};

export const externalIdMappingKeys = {
  all: ["chatops", "external-id-mappings"] as const,
  byUser: (userId: string) =>
    [...externalIdMappingKeys.all, "user", userId] as const,
};

export function useExternalIdMappings(userId?: string) {
  return useQuery({
    queryKey: externalIdMappingKeys.byUser(userId ?? ""),
    queryFn: async () => {
      if (!userId) return [] as ExternalIdMapping[];
      const response = (await archestraApiClient.get({
        url: "/api/chatops/external-id-mappings",
        query: { userId },
      })) as
        | { data: { data: ExternalIdMapping[] }; error: undefined }
        | { data: undefined; error: unknown };
      if (response.error) {
        handleApiError(response.error as Parameters<typeof handleApiError>[0]);
        return [];
      }
      return response.data?.data ?? [];
    },
    enabled: !!userId,
  });
}

export function useCreateExternalIdMapping() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (params: {
      userId: string;
      adapterId: string;
      externalId: string;
    }) => {
      const response = (await archestraApiClient.post({
        url: "/api/chatops/external-id-mappings",
        body: params,
        headers: { "Content-Type": "application/json" },
      })) as
        | { data: ExternalIdMapping; error: undefined }
        | { data: undefined; error: unknown };
      if (response.error) {
        handleApiError(response.error as Parameters<typeof handleApiError>[0]);
        return null;
      }
      return response.data;
    },
    onSuccess: (data) => {
      if (!data) return;
      toast.success("ChatOps account linked");
      queryClient.invalidateQueries({
        queryKey: externalIdMappingKeys.all,
      });
    },
  });
}

export function useDeleteExternalIdMapping() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const response = (await archestraApiClient.delete({
        url: `/api/chatops/external-id-mappings/${id}`,
      })) as
        | { data: { success: boolean }; error: undefined }
        | { data: undefined; error: unknown };
      if (response.error) {
        handleApiError(response.error as Parameters<typeof handleApiError>[0]);
        return null;
      }
      return response.data;
    },
    onSuccess: (data) => {
      if (!data) return;
      toast.success("ChatOps account unlinked");
      queryClient.invalidateQueries({
        queryKey: externalIdMappingKeys.all,
      });
    },
  });
}
