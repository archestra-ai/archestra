import { archestraApiSdk, type archestraApiTypes } from "@shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { environmentKeys } from "@/lib/environment.query";
import { usePresetEntityName } from "@/lib/organization.query";

const {
  createCatalogChild,
  createInternalMcpCatalogItem,
  deleteInternalMcpCatalogItem,
  getCatalogChildren,
  getDeploymentYamlPreview,
  getInternalMcpCatalog,
  getInternalMcpCatalogLabelKeys,
  getInternalMcpCatalogLabelValues,
  getInternalMcpCatalogTools,
  getK8sImagePullSecrets,
  refreshInternalMcpCatalogImage,
  reinstallInternalMcpCatalogItem,
  resetDeploymentYaml,
  updateCatalogChild,
  updateInternalMcpCatalogItem,
  validateDeploymentYaml,
} = archestraApiSdk;

type InternalMcpCatalogParams = {
  initialData?: archestraApiTypes.GetInternalMcpCatalogResponses["200"];
  enabled?: boolean;
  /** When true, include child preset rows (parentCatalogItemId IS NOT NULL) in the response. */
  includeChildren?: boolean;
};
type McpCatalogLabelValuesQuery = NonNullable<
  archestraApiTypes.GetInternalMcpCatalogLabelValuesData["query"]
>;
type UpdateInternalMcpCatalogItemParams =
  archestraApiTypes.UpdateInternalMcpCatalogItemData["path"] & {
    data: archestraApiTypes.UpdateInternalMcpCatalogItemData["body"];
  };

export function useInternalMcpCatalog(params?: InternalMcpCatalogParams) {
  const includeChildren = params?.includeChildren ?? false;
  return useQuery({
    queryKey: ["mcp-catalog", { includeChildren }],
    queryFn: async () =>
      (
        await getInternalMcpCatalog(
          includeChildren ? { query: { includeChildren: true } } : {},
        )
      ).data ?? [],
    initialData: params?.initialData,
    enabled: params?.enabled,
  });
}

export function useMcpCatalogLabelKeys() {
  return useQuery({
    queryKey: ["mcp-catalog", "labels", "keys"],
    queryFn: async () => (await getInternalMcpCatalogLabelKeys()).data ?? [],
  });
}

export function useMcpCatalogLabelValues(
  params?: Partial<McpCatalogLabelValuesQuery>,
) {
  const { key } = params || {};
  return useQuery({
    queryKey: ["mcp-catalog", "labels", "values", key],
    queryFn: async () =>
      (await getInternalMcpCatalogLabelValues({ query: key ? { key } : {} }))
        .data ?? [],
    enabled: !!key,
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
    mutationFn: async ({ id, data }: UpdateInternalMcpCatalogItemParams) => {
      const response = await updateInternalMcpCatalogItem({
        path: { id },
        body: data,
      });
      return response.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["mcp-catalog"] });
      queryClient.invalidateQueries({ queryKey: ["mcp-servers"] });
      queryClient.invalidateQueries({ queryKey: ["chat", "agents"] });
      queryClient.invalidateQueries({ queryKey: environmentKeys.list() });
      toast.success("Catalog item updated successfully");
    },
    onError: (error) => {
      console.error("Edit error:", error);
      toast.error("Failed to update catalog item");
    },
  });
}

/**
 * Reinstall the shared K8s Deployment for a multi-tenant local catalog.
 * Recreates the pod with the current catalog spec and cascades tool sync
 * to every install attached to the catalog. Only callable when
 * `catalog.catalogReinstallRequired === true`.
 */
export function useReinstallInternalMcpCatalogItem() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const response = await reinstallInternalMcpCatalogItem({
        path: { id },
      });
      return response.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["mcp-catalog"] });
      queryClient.invalidateQueries({ queryKey: ["mcp-servers"] });
      queryClient.invalidateQueries({ queryKey: ["chat", "agents"] });
      toast.success("Catalog reinstalled successfully");
    },
    onError: (error) => {
      console.error("Catalog reinstall error:", error);
      toast.error("Failed to reinstall catalog");
    },
  });
}

export function useRefreshInternalMcpCatalogImage() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const response = await refreshInternalMcpCatalogImage({
        path: { id },
      });
      return response.data;
    },
    onMutate: () => {
      toast.info("Starting pod restart");
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["mcp-catalog"] });
      queryClient.invalidateQueries({ queryKey: ["mcp-servers"] });
      queryClient.invalidateQueries({ queryKey: ["chat", "agents"] });
    },
    onError: (error) => {
      console.error("Pod restart error:", error);
      toast.error("Failed to start pod restart");
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

/**
 * Fetch deployment YAML template preview for a catalog item.
 */
export function useGetDeploymentYamlPreview(catalogId: string | null) {
  return useQuery({
    queryKey: ["mcp-catalog", catalogId, "deployment-yaml-preview"],
    queryFn: async () => {
      if (!catalogId) return null;
      const response = await getDeploymentYamlPreview({
        path: { id: catalogId },
      });
      return response.data;
    },
    enabled: !!catalogId,
  });
}

/**
 * Validate deployment YAML template.
 */
export function useValidateDeploymentYaml() {
  return useMutation({
    mutationFn: async (
      params: NonNullable<archestraApiTypes.ValidateDeploymentYamlData["body"]>,
    ) => {
      const response = await validateDeploymentYaml({ body: params });
      return response.data;
    },
  });
}

/**
 * Reset deployment YAML to default by clearing the custom YAML from the database.
 * Returns the freshly generated default YAML.
 */
export function useResetDeploymentYaml() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (catalogId: string) => {
      const response = await resetDeploymentYaml({ path: { id: catalogId } });
      return response.data;
    },
    onSuccess: (_data, catalogId) => {
      // Invalidate the main catalog query to refresh the form data
      queryClient.invalidateQueries({ queryKey: ["mcp-catalog"] });
      // Invalidate the preview query
      queryClient.invalidateQueries({
        queryKey: ["mcp-catalog", catalogId, "deployment-yaml-preview"],
      });
      toast.success("Deployment YAML reset to default");
    },
    onError: (error) => {
      console.error("Reset deployment YAML error:", error);
      toast.error("Failed to reset deployment YAML");
    },
  });
}

/**
 * Fetch Kubernetes docker-registry secrets available for imagePullSecrets.
 */
export function useK8sImagePullSecrets() {
  return useQuery({
    queryKey: ["k8s-image-pull-secrets"],
    queryFn: async () => {
      const response = await getK8sImagePullSecrets();
      return response.data ?? [];
    },
  });
}

/**
 * A "preset" in the UI is a child catalog item — a row in
 * internal_mcp_catalog with `parentCatalogItemId` set to the parent's id.
 * The parent itself acts as the default preset and is NOT returned here.
 */
export type CatalogPreset =
  archestraApiTypes.GetCatalogChildrenResponses["200"][number];

export function useCatalogPresets(catalogId: string | null) {
  return useQuery({
    queryKey: ["mcp-catalog", catalogId, "presets"],
    queryFn: async () => {
      if (!catalogId) return [];
      const response = await getCatalogChildren({ path: { catalogId } });
      return response.data ?? [];
    },
    enabled: !!catalogId,
  });
}

export function useCreateCatalogPreset(catalogId: string) {
  const queryClient = useQueryClient();
  const { singular } = usePresetEntityName();
  return useMutation({
    mutationFn: async (
      data: archestraApiTypes.CreateCatalogChildData["body"],
    ) => {
      const response = await createCatalogChild({
        path: { catalogId },
        body: data,
      });
      return response.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ["mcp-catalog", catalogId, "presets"],
      });
      toast.success(`${singular} created`);
    },
    onError: (error) => {
      console.error("Create preset error:", error);
      toast.error(`Failed to create ${singular}`);
    },
  });
}

export function useUpdateCatalogPreset(catalogId: string) {
  const queryClient = useQueryClient();
  const { singular } = usePresetEntityName();
  return useMutation({
    mutationFn: async (params: {
      presetId: string;
      data: archestraApiTypes.UpdateCatalogChildData["body"];
    }) => {
      const response = await updateCatalogChild({
        path: { catalogId, childId: params.presetId },
        body: params.data,
      });
      return response.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ["mcp-catalog", catalogId, "presets"],
      });
      queryClient.invalidateQueries({ queryKey: ["mcp-servers"] });
      toast.success(`${singular} updated`);
    },
    onError: (error) => {
      console.error("Update preset error:", error);
      toast.error(`Failed to update ${singular}`);
    },
  });
}
