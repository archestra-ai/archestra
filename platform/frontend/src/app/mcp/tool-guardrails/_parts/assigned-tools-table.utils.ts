import {
  AGENT_TOOL_PREFIX,
  ARCHESTRA_MCP_CATALOG_ID,
  type archestraApiTypes,
  isAgentTool,
} from "@archestra/shared";

type InternalMcpCatalogItem =
  archestraApiTypes.GetInternalMcpCatalogResponses["200"][number];

export const OBSERVED_TOOL_SOURCE_LABEL = "Observed tools";
export const OBSERVED_TOOL_SOURCE_DESCRIPTION =
  "Tools observed in agent-provider traffic, not installed from an MCP server catalog.";
export const MCP_TOOL_SOURCE_LABEL = "MCP Server";
export const APP_TOOL_SOURCE_LABEL = "App";
export const APP_TOOL_SOURCE_DESCRIPTION =
  "The launch tool of an app, which opens it and renders its UI.";
/** `origin` filter value matching every app launch tool, whichever app backs it. */
export const APP_ORIGIN_FILTER_VALUE = "app";

/**
 * Where a tool came from, as the table and details dialog label it.
 *
 * Anything with a `catalogId` is catalog-backed and must never be labeled as
 * observed traffic — including when its catalog is missing from `catalogItems`,
 * which happens for app backings (kept out of the registry listing) and for
 * catalogs the viewer cannot read. Falling through to "Observed tools" in that
 * case both mislabeled app launch tools and contradicted the source filter,
 * which correctly returned nothing for them.
 */
export type ToolSource =
  | { kind: "app"; appName: string }
  | { kind: "mcp"; catalogItem: InternalMcpCatalogItem | undefined }
  | { kind: "agent"; agentName: string }
  | { kind: "observed" };

export function getToolSource(
  tool: { catalogId: string | null; name: string },
  catalogItems?: InternalMcpCatalogItem[],
): ToolSource {
  if (tool.catalogId) {
    const catalogItem = catalogItems?.find(
      (item) => item.id === tool.catalogId,
    );
    if (catalogItem && isAppCatalogItem(catalogItem)) {
      return { kind: "app", appName: catalogItem.name };
    }
    return { kind: "mcp", catalogItem };
  }

  if (isAgentTool(tool.name)) {
    return {
      kind: "agent",
      agentName: tool.name.slice(AGENT_TOOL_PREFIX.length).replaceAll("_", " "),
    };
  }

  return { kind: "observed" };
}

/**
 * The catalogs offered as individual entries in the source filter. App backings
 * are excluded: they are one catalog per app, so a deployment with many apps
 * would bury the MCP servers — the single "App" entry
 * ({@link APP_ORIGIN_FILTER_VALUE}) covers them instead.
 */
export function getVisibleCatalogSources(
  internalMcpCatalogItems?: InternalMcpCatalogItem[],
) {
  const uniqueSources = new Map<string, InternalMcpCatalogItem>();

  internalMcpCatalogItems?.forEach((item) => {
    if (item.id === ARCHESTRA_MCP_CATALOG_ID || isAppCatalogItem(item)) {
      return;
    }

    uniqueSources.set(item.id, item);
  });

  return Array.from(uniqueSources.values());
}

export function hasAppCatalogSources(
  internalMcpCatalogItems?: InternalMcpCatalogItem[],
) {
  return Boolean(internalMcpCatalogItems?.some(isAppCatalogItem));
}

function isAppCatalogItem(item: InternalMcpCatalogItem) {
  return item.serverType === "app";
}
