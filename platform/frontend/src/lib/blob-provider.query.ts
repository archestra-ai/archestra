import { archestraApiSdk, type archestraApiTypes } from "@archestra/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { handleApiError, throwOnApiError, toApiError } from "@/lib/utils/api";

export type BlobProvider =
  archestraApiTypes.ListBlobProvidersResponses["200"][number];
export type CreateBlobProviderBody =
  archestraApiTypes.CreateBlobProviderData["body"];
export type UpdateBlobProviderBody =
  archestraApiTypes.UpdateBlobProviderData["body"];

export const blobProviderKeys = {
  all: ["blob-providers"] as const,
  list: () => [...blobProviderKeys.all, "list"] as const,
};

export function useBlobProviders() {
  const { data: canRead } = useHasPermissions({
    organizationSettings: ["read"],
  });
  return useQuery({
    queryKey: blobProviderKeys.list(),
    queryFn: async () => {
      const { data, error } = await archestraApiSdk.listBlobProviders();
      throwOnApiError(error);
      return data ?? [];
    },
    enabled: !!canRead,
  });
}

export function useCreateBlobProvider() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (body: CreateBlobProviderBody) => {
      const { data, error } = await archestraApiSdk.createBlobProvider({
        body,
      });
      if (error) {
        handleApiError(error);
        throw toApiError(error);
      }
      return data;
    },
    onSuccess: (provider) => {
      queryClient.invalidateQueries({ queryKey: blobProviderKeys.all });
      toast.success(`${provider.name} added`);
    },
  });
}

export function useUpdateBlobProvider() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (params: {
      id: string;
      body: UpdateBlobProviderBody;
    }) => {
      const { data, error } = await archestraApiSdk.updateBlobProvider({
        path: { id: params.id },
        body: params.body,
      });
      if (error) {
        handleApiError(error);
        throw toApiError(error);
      }
      return data;
    },
    onSuccess: (provider) => {
      queryClient.invalidateQueries({ queryKey: blobProviderKeys.all });
      toast.success(`${provider.name} updated`);
    },
  });
}

export function useDeleteBlobProvider() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await archestraApiSdk.deleteBlobProvider({
        path: { id },
      });
      if (error) {
        handleApiError(error);
        throw toApiError(error);
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: blobProviderKeys.all });
      toast.success("Blob provider deleted");
    },
  });
}

export function useTestBlobProvider() {
  return useMutation({
    mutationFn: async (id: string) => {
      const { data, error } = await archestraApiSdk.testBlobProvider({
        path: { id },
      });
      if (error) {
        handleApiError(error);
        throw toApiError(error);
      }
      return data;
    },
    onSuccess: (result) => {
      if (result.success) {
        toast.success("Connection works", { description: result.message });
      } else {
        toast.error("Connection failed", { description: result.message });
      }
    },
  });
}
