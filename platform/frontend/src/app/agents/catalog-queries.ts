import {
  type archestraApiTypes,
  DEFAULT_RESOURCE_ACCESS_RELATIONS,
} from "@archestra/shared";
import { DEFAULT_SORT_BY, DEFAULT_SORT_DIRECTION } from "@/consts";

// The Agents page's catalog requests, built in one place so the server
// component streams exactly the queries the page then reads.

type CatalogQuery = NonNullable<archestraApiTypes.GetAgentCatalogData["query"]>;
export type CatalogFilters = Omit<CatalogQuery, "limit" | "offset">;

/** The filters of /agents with no search parameters. */
export const DEFAULT_CATALOG_FILTERS = {
  sortBy: DEFAULT_SORT_BY,
  sortDirection: DEFAULT_SORT_DIRECTION,
  access: DEFAULT_RESOURCE_ACCESS_RELATIONS,
} satisfies CatalogFilters;

export function agentListQuery({
  filters,
  pageIndex,
  pageSize,
  isDeletedView,
  excludeIds,
}: {
  filters: CatalogFilters;
  pageIndex: number;
  pageSize: number;
  isDeletedView: boolean;
  excludeIds: string[] | undefined;
}): CatalogQuery {
  return {
    limit: pageSize,
    offset: pageIndex * pageSize,
    pinned: isDeletedView ? undefined : false,
    ...filters,
    ...(excludeIds?.length ? { excludeIds } : {}),
  };
}

export function pinnedAgentsQuery(filters: CatalogFilters): CatalogQuery {
  return {
    limit: 100,
    offset: 0,
    ...filters,
    status: undefined,
    // The list leaves built-in agents out; a pinned one still gets its tile.
    includeBuiltIn: true,
    pinned: true,
  };
}

/** The agents pinned for the viewer, as list rows. */
export function automaticPinsQuery(ids: string[] | undefined): CatalogQuery {
  return { limit: 20, offset: 0, ids };
}

/**
 * Pinned for the viewer without their pinning them: what starts their chats,
 * the assistant made for them, and the organization's default.
 */
export function pinsForViewer({
  personalDefaultAgentId,
  personalChatAgentId,
  organizationDefaultAgentId,
}: {
  personalDefaultAgentId: string | null | undefined;
  personalChatAgentId: string | null | undefined;
  organizationDefaultAgentId: string | null | undefined;
}) {
  return collectPinReasons([
    [personalDefaultAgentId, "Your default"],
    [personalChatAgentId, "Personal agent"],
    [organizationDefaultAgentId, "Org default"],
  ]);
}

/** The table leaves the automatic pins out, by id, in a stable order. */
export function automaticPinIds(
  pins: Array<{ id: string }>,
): string[] | undefined {
  return pins.length ? pins.map(({ id }) => id).sort() : undefined;
}

// ===

/**
 * Agents pinned for the viewer with every reason each one is, in the order
 * given, so one agent that is both your default and your personal agent is
 * one tile with two chips.
 */
function collectPinReasons(
  entries: Array<[string | null | undefined, string]>,
): Array<{ id: string; reasons: string[] }> {
  const byId = new Map<string, string[]>();
  for (const [id, reason] of entries) {
    if (!id) continue;
    byId.set(id, [...(byId.get(id) ?? []), reason]);
  }
  return [...byId].map(([id, reasons]) => ({ id, reasons }));
}
