import {
  useMutation,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query";
import { toast } from "sonner";
import {
  createInternalMcpCatalogItem,
  deleteInternalMcpCatalogItem,
  type GetInternalMcpCatalogResponses,
  getInternalMcpCatalog,
  type UpdateInternalMcpCatalogItemData,
  updateInternalMcpCatalogItem,
} from "@/lib/clients/api";

export function useInternalMcpCatalog(params?: {
  initialData?: GetInternalMcpCatalogResponses["200"];
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
    mutationFn: async (data: {
      label?: string;
      name: string;
      version?: string;
      serverType?: "local" | "remote";
      serverUrl?: string;
      docsUrl?: string;
      userConfig?: Record<
        string,
        {
          type: "string" | "number" | "boolean" | "directory" | "file";
          title: string;
          description: string;
          required?: boolean;
          default?: string | number | boolean | Array<string>;
          multiple?: boolean;
          sensitive?: boolean;
          min?: number;
          max?: number;
        }
      >;
      oauthConfig?: {
        name: string;
        server_url: string;
        auth_server_url?: string;
        resource_metadata_url?: string;
        client_id: string;
        client_secret?: string;
        redirect_uris: Array<string>;
        scopes: Array<string>;
        description?: string;
        well_known_url?: string;
        default_scopes: Array<string>;
        supports_resource_metadata: boolean;
        generic_oauth?: boolean;
        token_endpoint?: string;
        access_token_env_var?: string;
        requires_proxy?: boolean;
        provider_name?: string;
        browser_auth?: boolean;
        streamable_http_url?: string;
        streamable_http_port?: number;
      };
    }) => {
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
      data: UpdateInternalMcpCatalogItemData["body"];
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
