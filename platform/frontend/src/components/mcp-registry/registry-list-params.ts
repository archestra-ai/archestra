import type { McpServerAttentionFacet } from "@/lib/mcp/mcp-server-issues";

/**
 * The registry list's URL values, without React, so the request a URL makes
 * can be built before the page renders and on the server.
 */

export type SortKey =
  | "attention"
  | "name-asc"
  | "name-desc"
  | "newest"
  | "oldest"
  | "most-tools"
  | "issue-age";

export const INSTALLED_STATUS_VALUE = "installed";
export const NOT_INSTALLED_STATUS_VALUE = "not-installed";

/**
 * The audience facets, as status values. They share the `status` param with
 * the installed/not-installed options but are mutually exclusive with each
 * other, because an item belongs to exactly one facet and a viewer asking
 * "what is mine" is asking one question, not building a set.
 */
export const ATTENTION_FACET_STATUS_VALUES = {
  you: "needs-my-action",
  others: "waiting-on-someone-else",
  muted: "muted",
} as const satisfies Record<McpServerAttentionFacet, string>;

const FACET_BY_STATUS_VALUE = new Map<string, McpServerAttentionFacet>(
  (
    Object.entries(ATTENTION_FACET_STATUS_VALUES) as [
      McpServerAttentionFacet,
      string,
    ][]
  ).map(([facet, value]) => [value, facet]),
);

/** The facet a `status` selection is narrowed to, or null for the whole list. */
export function selectedAttentionFacet(
  status: Set<string>,
): McpServerAttentionFacet | null {
  for (const value of status) {
    const facet = FACET_BY_STATUS_VALUE.get(value);
    if (facet) return facet;
  }
  return null;
}

/**
 * `status` with exactly one facet selected, or none. The facets replace each
 * other rather than accumulating: an item belongs to exactly one of them, so a
 * selection of two would always be a selection of everything.
 */
export function withAttentionFacet(
  status: Set<string>,
  facet: McpServerAttentionFacet | null,
): Set<string> {
  const next = new Set(
    [...status].filter((value) => !FACET_BY_STATUS_VALUE.has(value)),
  );
  if (facet) next.add(ATTENTION_FACET_STATUS_VALUES[facet]);
  return next;
}

/** Where the registry list keeps its table/card preference (storage and cookie). */
export const MCP_REGISTRY_VIEW_STORAGE_KEY = "archestra-mcp-registry-view";
