import {
  ARCHESTRA_MCP_CATALOG_ID,
  DEFAULT_ARCHESTRA_TOOL_NAMES,
  parseFullToolName,
} from "@shared";

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
      .filter((t) => DEFAULT_ARCHESTRA_TOOL_NAMES.includes(t.name))
      .map((t) => t.id),
  );

  if (toolIds.size === 0) return null;

  return { toolIds, catalogIndex };
}

/**
 * Filter tools by search query (matching formatted name or description)
 * and sort with selected tools first.
 */
export function sortAndFilterTools<
  T extends { id: string; name: string; description?: string | null },
>(tools: T[], selectedToolIds: Set<string>, searchQuery: string): T[] {
  let result: T[] = tools;
  if (searchQuery.trim()) {
    const query = searchQuery.toLowerCase();
    result = tools.filter((tool) => {
      const formattedName = parseFullToolName(tool.name).toolName || tool.name;
      return (
        formattedName.toLowerCase().includes(query) ||
        (tool.description?.toLowerCase().includes(query) ?? false)
      );
    });
  }

  // Use original index as tiebreaker so sort order is deterministic
  // regardless of engine sort stability.
  const indexMap = new Map(result.map((t, i) => [t.id, i]));
  return [...result].sort((a, b) => {
    const aSelected = selectedToolIds.has(a.id) ? 0 : 1;
    const bSelected = selectedToolIds.has(b.id) ? 0 : 1;
    if (aSelected !== bSelected) return aSelected - bSelected;
    return (indexMap.get(a.id) ?? 0) - (indexMap.get(b.id) ?? 0);
  });
}
