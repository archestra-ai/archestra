import { ARCHESTRA_MCP_CATALOG_ID, type archestraApiTypes } from "@shared";

type InternalMcpCatalogItem =
  archestraApiTypes.GetInternalMcpCatalogResponses["200"][number];

export function getVisibleCatalogSources(
  internalMcpCatalogItems?: InternalMcpCatalogItem[],
) {
  const uniqueSources = new Map<string, InternalMcpCatalogItem>();

  internalMcpCatalogItems?.forEach((item) => {
    if (item.id === ARCHESTRA_MCP_CATALOG_ID) {
      return;
    }

    uniqueSources.set(item.id, item);
  });

  return Array.from(uniqueSources.values());
}
