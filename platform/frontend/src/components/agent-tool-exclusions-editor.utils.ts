import {
  ARCHESTRA_MCP_CATALOG_ID,
  isPrefillExemptArchestraToolShortName,
  parseFullToolName,
  TOOL_RUN_TOOL_SHORT_NAME,
  TOOL_SEARCH_TOOLS_SHORT_NAME,
} from "@archestra/shared";
import type { AgentToolExclusions } from "@/lib/agent-tool-exclusions.query";

/**
 * One excluded-server pill in the Auto-mode exclusions editor. The editor
 * groups tools by MCP server (catalog) for display, but exclusion is purely
 * per-tool: `selectedToolIds` is always an explicit set of excluded tool ids.
 * A pill with every excludable tool of its server selected simply serializes
 * to that server's individual tool ids.
 */
export type PendingExclusionEntry = {
  catalogId: string;
  selectedToolIds: Set<string>;
};

export const EMPTY_EXCLUSIONS: AgentToolExclusions = {
  excludedToolIds: [],
};

/**
 * Tools offered in a server's exclusion checklist. The built-in catalog's
 * meta dispatch tools (search_tools / run_tool) are never excludable, so they
 * are hidden from its checklist.
 */
export function filterExcludableTools<T extends { name: string }>(
  catalogId: string,
  tools: T[],
): T[] {
  if (catalogId !== ARCHESTRA_MCP_CATALOG_ID) return tools;
  return tools.filter(
    (tool) =>
      !NON_EXCLUDABLE_SHORT_NAMES.has(parseFullToolName(tool.name).toolName),
  );
}

/**
 * Map pill/checklist selections to the PUT payload. Every selection resolves
 * to tool ids — a pill covering every excludable tool of its server serializes
 * to that server's individual tool ids (there is no whole-server/catalog
 * exclusion). Entries with an empty selection exclude nothing. `unresolvedToolIds`
 * (loaded exclusions whose tool no longer appears in any server list) are
 * preserved so saving doesn't silently drop them.
 *
 * The output array is sorted so payloads compare stably.
 */
export function buildExclusionPayload(params: {
  entries: Iterable<PendingExclusionEntry>;
  unresolvedToolIds?: Iterable<string>;
}): AgentToolExclusions {
  const toolIds = new Set<string>(params.unresolvedToolIds ?? []);

  for (const entry of params.entries) {
    for (const id of entry.selectedToolIds) toolIds.add(id);
  }

  return {
    excludedToolIds: [...toolIds].sort(),
  };
}

/**
 * Build the initial pill state from loaded exclusions: excluded tool ids are
 * grouped into per-server entries via the server tool lists (a server shows as
 * fully excluded when all its excludable tools are in the set). Tool ids not
 * found in any server list are returned as `unresolvedToolIds`.
 */
export function buildInitialEntries(params: {
  exclusions: AgentToolExclusions;
  toolIdsByCatalog: ReadonlyMap<string, readonly string[]>;
}): {
  entries: Map<string, PendingExclusionEntry>;
  unresolvedToolIds: string[];
} {
  const toolCatalogById = new Map<string, string>();
  for (const [catalogId, ids] of params.toolIdsByCatalog) {
    for (const id of ids) toolCatalogById.set(id, catalogId);
  }

  const entries = new Map<string, PendingExclusionEntry>();
  const unresolvedToolIds: string[] = [];
  for (const toolId of params.exclusions.excludedToolIds) {
    const catalogId = toolCatalogById.get(toolId);
    if (!catalogId) {
      unresolvedToolIds.push(toolId);
      continue;
    }
    const existing = entries.get(catalogId);
    if (existing) {
      existing.selectedToolIds.add(toolId);
    } else {
      entries.set(catalogId, {
        catalogId,
        selectedToolIds: new Set([toolId]),
      });
    }
  }

  return { entries, unresolvedToolIds };
}

/**
 * Client-side mirror of the backend's All-tools exclusion pre-fill: from the
 * built-in catalog's excludable tools, every tool that is neither assigned to
 * the agent nor pre-fill-exempt gets excluded by default. "Assigned" is either
 * an explicit tool-id set (editing an existing agent, from its saved
 * assignments) or a short-name set the backend is known to auto-assign at
 * creation (new agent, no assignments exist yet). Short names are resolved via
 * `parseFullToolName`, so branded prefixes (e.g. `acme__whoami`) match too.
 */
export function computeDefaultExclusionToolIds(params: {
  /** The built-in catalog's excludable tools (post `filterExcludableTools`). */
  builtInTools: readonly { id: string; name: string }[];
  /** Tool ids saved as assigned to the agent (existing agent). */
  assignedToolIds?: ReadonlySet<string>;
  /** Short names the backend auto-assigns at creation (new agent). */
  assumedAssignedShortNames?: ReadonlySet<string>;
}): string[] {
  const ids: string[] = [];
  for (const tool of params.builtInTools) {
    const shortName = parseFullToolName(tool.name).toolName;
    if (isPrefillExemptArchestraToolShortName(shortName)) continue;
    if (params.assignedToolIds?.has(tool.id)) continue;
    if (params.assumedAssignedShortNames?.has(shortName)) continue;
    ids.push(tool.id);
  }
  return ids;
}

/**
 * Union-merge the server-saved exclusions with the client-computed default
 * exclusion tool ids (deduped, sorted for stable comparison). The seeded
 * initial state of the editor when the agent is entering All-tools mode.
 */
export function mergeExclusionsWithDefaultToolIds(params: {
  exclusions: AgentToolExclusions;
  defaultExcludedToolIds: readonly string[];
}): AgentToolExclusions {
  return {
    excludedToolIds: [
      ...new Set([
        ...params.exclusions.excludedToolIds,
        ...params.defaultExcludedToolIds,
      ]),
    ].sort(),
  };
}

/**
 * Order-independent content key for an exclusions payload; used for effect
 * dependencies and change detection.
 */
export function exclusionsKey(exclusions: AgentToolExclusions): string {
  return JSON.stringify([...exclusions.excludedToolIds].sort());
}

// === internal ===

// Must match the backend PUT validation: only the search_tools/run_tool meta
// tools are rejected server-side, so they are all the picker hides.
const NON_EXCLUDABLE_SHORT_NAMES = new Set<string>([
  TOOL_SEARCH_TOOLS_SHORT_NAME,
  TOOL_RUN_TOOL_SHORT_NAME,
]);
