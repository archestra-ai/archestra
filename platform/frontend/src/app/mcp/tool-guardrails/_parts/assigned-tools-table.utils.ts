import {
  ARCHESTRA_MCP_CATALOG_ID,
  type archestraApiTypes,
} from "@archestra/shared";

type InternalMcpCatalogItem =
  archestraApiTypes.GetInternalMcpCatalogResponses["200"][number];

export const OBSERVED_TOOL_SOURCE_LABEL = "Observed tools";
export const OBSERVED_TOOL_SOURCE_DESCRIPTION =
  "Tools observed in agent-provider traffic, not installed from an MCP server catalog.";

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
