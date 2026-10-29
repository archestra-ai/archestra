import type { archestraApiTypes } from "@archestra/shared";

// Free of React, so the Agents page's server component can build the same
// keys as `useAgentCatalog`.

export const agentCatalogQueryKeys = {
  all: ["agents", "catalog"] as const,
  list: (query: archestraApiTypes.GetAgentCatalogData["query"]) =>
    [...agentCatalogQueryKeys.all, query] as const,
};

/**
 * The request a catalog list makes, which is also its query key's last part.
 * The Agents page's server component builds the same one to stream it.
 */
export function agentCatalogListQuery(
  params?: archestraApiTypes.GetAgentCatalogData["query"],
): NonNullable<archestraApiTypes.GetAgentCatalogData["query"]> {
  // Rows carry their tool and subagent counts; the tools themselves are most
  // of a row's bytes and the Agents page shows none of them.
  return { includeTools: false, ...params };
}
