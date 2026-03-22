import {
  ARCHESTRA_MCP_CATALOG_ID,
  DEFAULT_ARCHESTRA_TOOL_SHORT_NAMES,
  parseFullToolName,
} from "@shared";

const DEFAULT_ARCHESTRA_TOOL_SHORT_NAME_SET = new Set<string>(
  DEFAULT_ARCHESTRA_TOOL_SHORT_NAMES,
);

/**
 * Given catalog items and a parallel array of tool lists, find the default
 * Archestra tools and return their IDs plus the catalog index.
 *
 * Returns null if the Archestra catalog isn't found, tools aren't loaded,
 * or no default tools match.
 */
export function getDefaultArchestraToolIds(
  catalogItems: { id: string; name: string }[],
  toolsByCatalogIndex: ({ id: string; name: string }[] | undefined)[],
): { toolIds: Set<string>; catalogIndex: number } | null {
  const catalogIndex = catalogItems.findIndex(
    (c) => c.id === ARCHESTRA_MCP_CATALOG_ID,
  );
  if (catalogIndex === -1) return null;

  const tools = toolsByCatalogIndex[catalogIndex];
  if (!tools || tools.length === 0) return null;

  const toolIds = new Set(
    tools
      .filter((t) => {
        const shortName = parseFullToolName(t.name).toolName;
        return (
          shortName !== null &&
          DEFAULT_ARCHESTRA_TOOL_SHORT_NAME_SET.has(shortName)
        );
      })
      .map((t) => t.id),
  );

  if (toolIds.size === 0) return null;

  return { toolIds, catalogIndex };
}

export function sortCatalogItems<
  T extends { id: string; name: string; serverType?: string | null },
>(
  catalogItems: T[],
  getAssignedCount: (catalog: T) => number,
  getToolCount: (catalog: T) => number,
): T[] {
  return [...catalogItems].sort((a, b) => {
    const aIsBuiltIn = a.id === ARCHESTRA_MCP_CATALOG_ID ? 1 : 0;
    const bIsBuiltIn = b.id === ARCHESTRA_MCP_CATALOG_ID ? 1 : 0;
    if (aIsBuiltIn !== bIsBuiltIn) return bIsBuiltIn - aIsBuiltIn;

    const aAssigned = getAssignedCount(a);
    const bAssigned = getAssignedCount(b);

    if (aAssigned > 0 && bAssigned === 0) return -1;
    if (aAssigned === 0 && bAssigned > 0) return 1;
    if (aAssigned !== bAssigned) return bAssigned - aAssigned;

    const aCount = getToolCount(a);
    const bCount = getToolCount(b);
    if (aCount > 0 && bCount === 0) return -1;
    if (aCount === 0 && bCount > 0) return 1;

    return a.name.localeCompare(b.name);
  });
}

/**
 * Filter tools by search query (matching formatted name or description)
 * and sort with selected tools first.
 */
export function sortAndFilterTools<
  T extends { id: string; name: string; description?: string | null },
>(tools: T[], selectedToolIds: Set<string>, searchQuery: string): T[] {
  const normalizedQuery = searchQuery.trim().toLowerCase();
  let result: T[] = tools;
  if (normalizedQuery) {
    result = tools.filter((tool) => {
      const formattedName = parseFullToolName(tool.name).toolName || tool.name;
      return getToolSearchMatchScore(tool, formattedName, normalizedQuery) > 0;
    });
  }

  // Use original index as tiebreaker so sort order is deterministic
  // regardless of engine sort stability.
  const indexMap = new Map(result.map((t, i) => [t.id, i]));
  return [...result].sort((a, b) => {
    const aSelected = selectedToolIds.has(a.id) ? 0 : 1;
    const bSelected = selectedToolIds.has(b.id) ? 0 : 1;
    if (aSelected !== bSelected) return aSelected - bSelected;
    const aFormattedName = parseFullToolName(a.name).toolName || a.name;
    const bFormattedName = parseFullToolName(b.name).toolName || b.name;
    const aScore = normalizedQuery
      ? getToolSearchMatchScore(a, aFormattedName, normalizedQuery)
      : 0;
    const bScore = normalizedQuery
      ? getToolSearchMatchScore(b, bFormattedName, normalizedQuery)
      : 0;
    if (aScore !== bScore) return bScore - aScore;
    return (indexMap.get(a.id) ?? 0) - (indexMap.get(b.id) ?? 0);
  });
}

function getToolSearchMatchScore<T extends { description?: string | null }>(
  tool: T,
  formattedName: string,
  query: string,
) {
  const name = formattedName.toLowerCase();
  const description = tool.description?.toLowerCase() ?? "";

  if (name === query) return 5;
  if (name.startsWith(query)) return 4;
  if (name.includes(query)) return 3;
  if (description.startsWith(query)) return 2;
  if (description.includes(query)) return 1;
  return 0;
}
