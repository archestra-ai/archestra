import { archestraApiSdk, type archestraApiTypes } from "@archestra/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { environmentKeys } from "@/lib/environment.query";
import { throwOnApiError } from "@/lib/utils";

const {
  approveCatalogItemImage,
  createInternalMcpCatalogItem,
  deleteInternalMcpCatalogItem,
  getDeploymentYamlPreview,
  getInternalMcpCatalog,
  getInternalMcpCatalogLabelKeys,
  getInternalMcpCatalogLabelValues,
  getInternalMcpCatalogTools,
  getK8sImagePullSecrets,
  refreshInternalMcpCatalogImage,
  reinstallInternalMcpCatalogItem,
  resetDeploymentYaml,
  updateInternalMcpCatalogItem,
  validateDeploymentYaml,
} = archestraApiSdk;

type InternalMcpCatalogParams = {
  initialData?: archestraApiTypes.GetInternalMcpCatalogResponses["200"];
  enabled?: boolean;
};
type McpCatalogLabelValuesQuery = NonNullable<
  archestraApiTypes.GetInternalMcpCatalogLabelValuesData["query"]
>;
type UpdateInternalMcpCatalogItemParams =
  archestraApiTypes.UpdateInternalMcpCatalogItemData["path"] & {
    data: archestraApiTypes.UpdateInternalMcpCatalogItemData["body"];
  };

/**
 * `internal_code` the backend sets when a remote server's URL host is rejected
 * by its environment's network egress policy. The dialogs use it to show the
 * message inline on the Server URL field instead of a generic toast. Keep in
 * sync with the backend constant of the same value.
 */
export const REMOTE_SERVER_URL_NOT_ALLOWED_CODE =
  "remote_server_url_not_allowed";

/** Read the backend `internal_code` off an error thrown by a catalog mutation. */
export function getCatalogMutationErrorCode(
  error: unknown,
): string | undefined {
  return (error as { internalCode?: string } | null)?.internalCode;
}

/** Convert a hey-api `{ error }` body into a thrown Error carrying its code. */
function catalogMutationError(body: {
  message: string;
  internal_code?: string;
}): Error {
  const error = new Error(body.message) as Error & { internalCode?: string };
  error.internalCode = body.internal_code;
  return error;
}

/**
 * `includeApps` adds App backing catalogs (whose launch tool is assignable from
 * the gateway capabilities picker) to the result. Apps stay out of the registry,
 * so registry surfaces omit it. The backend only honors it for callers with
 * `app:read`, so a caller without that permission silently gets the app-free list.
 */
export function useInternalMcpCatalog(
  params?: InternalMcpCatalogParams & { includeApps?: boolean },
) {
  const includeApps = params?.includeApps ?? false;
  return useQuery({
    queryKey: includeApps ? ["mcp-catalog", "with-apps"] : ["mcp-catalog"],
    queryFn: async () => {
      const { data, error } = await getInternalMcpCatalog(
        includeApps ? { query: { includeApps } } : {},
      );
      throwOnApiError(error, { toastOnError: false });
      return data ?? [];
    },
    initialData: params?.initialData,
    enabled: params?.enabled,
  });
}

export function useMcpCatalogLabelKeys() {
  return useQuery({
    queryKey: ["mcp-catalog", "labels", "keys"],
    queryFn: async () => {
      const { data, error } = await getInternalMcpCatalogLabelKeys();
      throwOnApiError(error, { toastOnError: false });
      return data ?? [];
    },
  });
}

export function useMcpCatalogLabelValues(
  params?: Partial<McpCatalogLabelValuesQuery>,
) {
  const { key } = params || {};
  return useQuery({
    queryKey: ["mcp-catalog", "labels", "values", key],
    queryFn: async () => {
      const { data, error } = await getInternalMcpCatalogLabelValues({
        query: key ? { key } : {},
      });
      throwOnApiError(error, { toastOnError: false });
      return data ?? [];
    },
    enabled: !!key,
  });
}

export function useCreateInternalMcpCatalogItem() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (
      data: archestraApiTypes.CreateInternalMcpCatalogItemData["body"],
    ) => {
      const { data: created, error } = await createInternalMcpCatalogItem({
        body: data,
      });
      if (error) throw catalogMutationError(error.error);
      return created;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["mcp-catalog"] });
      toast.success("Catalog item created successfully");
    },
    onError: (error) => {
      // The network-policy error is shown inline on the Server URL field by the
      // dialog; everything else falls back to a toast.
      if (
        getCatalogMutationErrorCode(error) ===
        REMOTE_SERVER_URL_NOT_ALLOWED_CODE
      ) {
        return;
      }
      toast.error(
        error instanceof Error
          ? error.message
          : "Failed to create catalog item",
      );
    },
  });
}

export function useApproveCatalogItemImage() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { data, error } = await approveCatalogItemImage({ path: { id } });
      throwOnApiError(error);
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["mcp-catalog"] });
      queryClient.invalidateQueries({ queryKey: ["mcp-servers"] });
      toast.success("Image approved");
    },
    onError: (error) => {
      toast.error(
        error instanceof Error ? error.message : "Failed to approve image",
      );
    },
  });
}

export function useUpdateInternalMcpCatalogItem() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, data }: UpdateInternalMcpCatalogItemParams) => {
      const { data: updated, error } = await updateInternalMcpCatalogItem({
        path: { id },
        body: data,
      });
      if (error) throw catalogMutationError(error.error);
      return updated;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["mcp-catalog"] });
      queryClient.invalidateQueries({ queryKey: ["mcp-servers"] });
      queryClient.invalidateQueries({ queryKey: ["chat", "agents"] });
      queryClient.invalidateQueries({ queryKey: environmentKeys.list() });
      toast.success("Catalog item updated successfully");
    },
    onError: (error) => {
      // The network-policy error is shown inline on the Server URL field by the
      // dialog; everything else falls back to a toast.
      if (
        getCatalogMutationErrorCode(error) ===
        REMOTE_SERVER_URL_NOT_ALLOWED_CODE
      ) {
        return;
      }
      toast.error(
        error instanceof Error
          ? error.message
          : "Failed to update catalog item",
      );
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
      const { data, error } = await getDeploymentYamlPreview({
        path: { id: catalogId },
      });
      throwOnApiError(error, { toastOnError: false });
      return data;
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
      const { data, error } = await getK8sImagePullSecrets();
      throwOnApiError(error, { toastOnError: false });
      return data ?? [];
    },
  });
}
