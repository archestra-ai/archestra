// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import {
  type archestraApiTypes,
  isBuiltInCatalogId,
  isPlaywrightCatalogItem,
} from "@archestra/shared";

type CatalogItem =
  archestraApiTypes.GetInternalMcpCatalogResponses["200"][number];

/** Use the same object-specific authorization decision as the catalog API. */
export function useCanModifyCatalogItem(
  catalog: CatalogItem | null | undefined,
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
