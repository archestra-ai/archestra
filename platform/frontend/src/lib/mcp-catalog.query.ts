import {
  useMutation,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query";
import { toast } from "sonner";
import {
  createMcpCatalogItem,
  deleteMcpCatalogItem,
  type GetMcpCatalogResponses,
  getMcpCatalog,
  type UpdateMcpCatalogItemData,
  updateMcpCatalogItem,
} from "@/lib/clients/api";

export function useMcpCatalog(params?: {
  initialData?: GetMcpCatalogResponses["200"];
}) {
  return useSuspenseQuery({
    queryKey: ["mcp-catalog"],
    queryFn: async () => (await getMcpCatalog()).data ?? [],
    initialData: params?.initialData,
  });
}

export function useCreateMcpCatalogItem() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (data: { name: string; version?: string }) => {
      const response = await createMcpCatalogItem({ body: data });
      return response.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["mcp-catalog"] });
      toast.success("Catalog item created successfully");
    },
    onError: (error) => {
      console.error("Create error:", error);
      toast.error("Failed to create catalog item");
    },
  });
}

export function useUpdateMcpCatalogItem() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      id,
      data,
    }: {
      id: string;
      data: UpdateMcpCatalogItemData["body"];
    }) => {
      const response = await updateMcpCatalogItem({ path: { id }, body: data });
      return response.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["mcp-catalog"] });
      toast.success("Catalog item updated successfully");
    },
    onError: (error) => {
      console.error("Edit error:", error);
      toast.error("Failed to update catalog item");
    },
  });
}

export function useDeleteMcpCatalogItem() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const response = await deleteMcpCatalogItem({ path: { id } });
      return response.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["mcp-catalog"] });
      toast.success("Catalog item deleted successfully");
    },
    onError: (error) => {
      console.error("Delete error:", error);
      toast.error("Failed to delete catalog item");
    },
  });
}
