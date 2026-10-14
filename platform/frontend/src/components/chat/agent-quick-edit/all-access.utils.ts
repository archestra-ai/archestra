/**
 * What an All-tools agent can reach, as the settings view summarizes it:
 * the servers with at least one tool left after exclusions, and a short
 * account of what is excluded. Exclusions are stored per tool, so a server
 * counts as excluded only when every one of its tools is.
 */
export function summarizeAllToolAccess<
  Catalog extends { id: string; name: string },
>(params: {
  catalogs: Catalog[];
  tools: ReadonlyArray<{ id: string; catalogId: string }>;
  excludedToolIds: readonly string[];
  /**
   * Servers whose partly excluded tools are counted as built-in: switching to
   * All pre-fills exclusions for most of the built-in server's tools, which
   * would otherwise read as a long list the user excluded by hand.
   */
  builtInCatalogIds?: ReadonlySet<string>;
}): {
  servers: Array<{ catalog: Catalog; toolCount: number }>;
  toolCount: number;
  excluded: string | null;
} {
  const excluded = new Set(params.excludedToolIds);
  const toolsByCatalog = new Map<string, { total: number; kept: number }>();
  for (const tool of params.tools) {
    const entry = toolsByCatalog.get(tool.catalogId) ?? { total: 0, kept: 0 };
    entry.total += 1;
    if (!excluded.has(tool.id)) entry.kept += 1;
    toolsByCatalog.set(tool.catalogId, entry);
  }

  const servers: Array<{ catalog: Catalog; toolCount: number }> = [];
  const fullyExcluded: string[] = [];
  let builtInExcludedTools = 0;
  let otherExcludedTools = 0;
  for (const catalog of params.catalogs) {
    const entry = toolsByCatalog.get(catalog.id);
    if (!entry) continue;
    if (entry.kept === 0) {
      fullyExcluded.push(catalog.name);
      continue;
    }
    servers.push({ catalog, toolCount: entry.kept });
    if (params.builtInCatalogIds?.has(catalog.id)) {
      builtInExcludedTools += entry.total - entry.kept;
    } else {
      otherExcludedTools += entry.total - entry.kept;
    }
  }

  const parts: string[] = [];
  if (fullyExcluded.length > 0) {
    parts.push(`${listNames(fullyExcluded, 2)} excluded`);
  }
  if (otherExcludedTools > 0) {
    parts.push(
      `${otherExcludedTools} ${fullyExcluded.length > 0 ? "other " : ""}${toolNoun(otherExcludedTools)} excluded`,
    );
  }
  if (builtInExcludedTools > 0) {
    parts.push(
      `${builtInExcludedTools} built-in ${toolNoun(builtInExcludedTools)} excluded by default`,
    );
  }

  return {
    servers,
    toolCount: servers.reduce((sum, server) => sum + server.toolCount, 0),
    excluded: parts.length > 0 ? parts.join(" · ") : null,
  };
}

/** "A, B, C and 4 more" — the first few names, then a count of the rest. */
export function listNames(names: readonly string[], shown: number): string {
  if (names.length <= shown) {
    return names.length <= 1
      ? (names[0] ?? "")
      : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
  }
  return `${names.slice(0, shown).join(", ")} and ${names.length - shown} more`;
}

function toolNoun(count: number) {
  return count === 1 ? "tool" : "tools";
}
