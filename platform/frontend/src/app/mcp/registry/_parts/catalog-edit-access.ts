// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import {
  type archestraApiTypes,
  isBuiltInCatalogId,
  isPlaywrightCatalogItem,
} from "@archestra/shared";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { useMcpDeploymentPermission } from "@/lib/mcp/use-mcp-deployment-permission";

type CatalogItem =
  archestraApiTypes.GetInternalMcpCatalogResponses["200"][number];

/** Use the same object-specific authorization decision as the catalog API. */
export function useCanModifyCatalogItem(
  catalog: Pick<CatalogItem, "id" | "effectiveActions"> | null | undefined,
): { canModify: boolean; isLoading: boolean } {
  return {
    canModify:
      !!catalog &&
      !isBuiltInCatalogId(catalog.id) &&
      !isPlaywrightCatalogItem(catalog.id) &&
      (catalog.effectiveActions?.includes("update") ?? false),
    isLoading: false,
  };
}

/**
 * Whether the caller may change what this entry runs or where it connects:
 * the right to add entries to the registry, or the deploy permission on this
 * one. Everyone else who may edit it (a member who owns it) edits its details
 * alone, which is all the backend accepts from them.
 */
export function useCanChangeCatalogRuntime(catalogId: string | undefined): {
  canChangeRuntime: boolean;
  isLoading: boolean;
} {
  const canCreate = useHasPermissions({ mcpRegistry: ["create"] });
  const canDeploy = useMcpDeploymentPermission(catalogId);
  return {
    canChangeRuntime: !!canCreate.data || !!canDeploy.data,
    isLoading: canCreate.isLoading || canDeploy.isLoading,
  };
}
