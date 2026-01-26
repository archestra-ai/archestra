import { archestraApiSdk, type archestraApiTypes } from "@shared";
import {
  useMutation,
  useQuery,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query";
import { toast } from "sonner";

const {
  createInternalMcpCatalogItem,
  deleteInternalMcpCatalogItem,
  getInternalMcpCatalog,
  getInternalMcpCatalogTools,
  updateInternalMcpCatalogItem,
} = archestraApiSdk;

/** Non-suspense version */
export function useInternalMcpCatalog(params?: {
  initialData?: archestraApiTypes.GetInternalMcpCatalogResponses["200"];
}) {
  return useQuery({
    queryKey: ["mcp-catalog"],
    queryFn: async () => (await getInternalMcpCatalog()).data ?? [],
    initialData: params?.initialData,
  });
}

export function useInternalMcpCatalogSuspense(params?: {
  initialData?: archestraApiTypes.GetInternalMcpCatalogResponses["200"];
}) {
  return useSuspenseQuery({
    queryKey: ["mcp-catalog"],
    queryFn: async () => (await getInternalMcpCatalog()).data ?? [],
    initialData: params?.initialData,
  });
}

export function useCreateInternalMcpCatalogItem() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (
      data: archestraApiTypes.CreateInternalMcpCatalogItemData["body"],
    ) => {
      const response = await createInternalMcpCatalogItem({ body: data });
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

export function useUpdateInternalMcpCatalogItem() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      id,
      data,
    }: {
      id: string;
      data: archestraApiTypes.UpdateInternalMcpCatalogItemData["body"];
    }) => {
      const response = await updateInternalMcpCatalogItem({
        path: { id },
        body: data,
      });
      return response.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["mcp-catalog"] });
      // Also invalidate MCP servers to refresh reinstallRequired flags
      queryClient.invalidateQueries({ queryKey: ["mcp-servers"] });
      // Invalidate all chat MCP tools (server config may have changed)
      queryClient.invalidateQueries({ queryKey: ["chat", "agents"] });
      toast.success("Catalog item updated successfully");
    },
    onError: (error) => {
      console.error("Edit error:", error);
      toast.error("Failed to update catalog item");
    },
  });
}

export function useDeleteInternalMcpCatalogItem() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const response = await deleteInternalMcpCatalogItem({ path: { id } });
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

export type CatalogTool =
  archestraApiTypes.GetInternalMcpCatalogToolsResponses["200"][number];

/**
 * Fetch tools for a catalog item by catalog ID (raw function for use with useQueries).
 */
export async function fetchCatalogTools(
  catalogId: string,
): Promise<CatalogTool[]> {
  try {
    const response = await getInternalMcpCatalogTools({
      path: { id: catalogId },
    });
    return response.data ?? [];
  } catch (error) {
    console.error("Failed to fetch catalog tools:", error);
    return [];
  }
}

/**
 * Fetch tools for a catalog item by catalog ID.
 * Used for builtin servers (like Archestra) that don't have a traditional MCP server installation.
 */
export function useCatalogTools(catalogId: string | null) {
  return useQuery({
    queryKey: ["mcp-catalog", catalogId, "tools"],
    queryFn: async () => {
      if (!catalogId) return [];
      return fetchCatalogTools(catalogId);
    },
    enabled: !!catalogId,
  });
}
