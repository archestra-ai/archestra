import { archestraApiSdk, type archestraApiTypes } from "@archestra/shared";
import {
  type DehydratedState,
  dehydrate,
  QueryClient,
} from "@tanstack/react-query";
import { DEFAULT_TABLE_LIMIT } from "@/consts";
import {
  agentCatalogListQuery,
  agentCatalogQueryKeys,
} from "@/lib/agent-catalog.keys";
import {
  agentListQuery,
  automaticPinIds,
  automaticPinsQuery,
  DEFAULT_CATALOG_FILTERS,
  pinnedAgentsQuery,
  pinsForViewer,
} from "./catalog-queries";

/**
 * What the server component needs from client modules it cannot import (they
 * use client-only APIs): the catalog's persistence meta, and the cache keys of
 * the viewer's member agents and organization. A test keeps these equal to
 * `PERSISTED_QUERY_META`, `memberDefaultAgentQueryKey` and
 * `organizationKeys.details()`.
 */
export const STREAMED_QUERY_META = { persist: true } as const;

export const STREAMED_QUERY_KEYS = {
  memberAgents: ["member-default-agent"],
  organization: ["organization", "details"],
} as const;

/**
 * Starts the default Agents view's catalog queries on the server and returns
 * them dehydrated while they are still in flight, for `StreamedQueries`.
 *
 * Only the viewer's member agents and the organization are awaited (two fast
 * reads): the viewer's automatic pins come from them, and the list's query
 * key leaves those pins out, so the server must know them to start the very
 * query the page will read. The catalog requests are never awaited; their
 * promises stream to the browser and resolve there.
 */
export async function streamAgentCatalog(
  headers: Record<string, string>,
): Promise<DehydratedState | null> {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  // `list` names the failed request in the error, for logs.
  const prefetchCatalog = (query: CatalogQuery, list: string) => {
    const request = agentCatalogListQuery(query);
    void client.prefetchQuery({
      queryKey: agentCatalogQueryKeys.list(request),
      queryFn: async () => {
        const { data, error } = await archestraApiSdk.getAgentCatalog({
          headers,
          query: request,
        });
        if (error) throw new Error(`Couldn't load the ${list}`);
        return data ?? null;
      },
      meta: STREAMED_QUERY_META,
    });
  };

  // The pinned agents do not depend on the automatic pins: start them first.
  prefetchCatalog(pinnedAgentsQuery(DEFAULT_CATALOG_FILTERS), "pinned agents");

  const [member, organization] = await Promise.all([
    archestraApiSdk.getMemberDefaultAgent({ headers }),
    archestraApiSdk.getOrganization({ headers }),
  ]);
  if (
    member.error ||
    !member.data ||
    organization.error ||
    !organization.data
  ) {
    // The page works these out itself; the pinned list still streams.
    return dehydrateInFlight(client);
  }

  const memberAgents = {
    defaultAgentId: member.data.defaultAgentId ?? null,
    personalChatAgentId: member.data.personalChatAgentId ?? null,
  };
  client.setQueryData(STREAMED_QUERY_KEYS.memberAgents, memberAgents);
  client.setQueryData(STREAMED_QUERY_KEYS.organization, organization.data);

  const excludeIds = automaticPinIds(
    pinsForViewer({
      personalDefaultAgentId: memberAgents.defaultAgentId,
      personalChatAgentId: memberAgents.personalChatAgentId,
      organizationDefaultAgentId: organization.data.defaultAgentId,
    }),
  );
  prefetchCatalog(
    agentListQuery({
      filters: DEFAULT_CATALOG_FILTERS,
      pageIndex: 0,
      pageSize: DEFAULT_TABLE_LIMIT,
      isDeletedView: false,
      excludeIds,
    }),
    "agent list",
  );
  if (excludeIds)
    prefetchCatalog(
      automaticPinsQuery(excludeIds),
      "automatically pinned agents",
    );

  return dehydrateInFlight(client);
}

// ===

type CatalogQuery = NonNullable<archestraApiTypes.GetAgentCatalogData["query"]>;

/**
 * Catalog queries always travel as promises, even one that has already
 * answered: the page then takes each the same way, as a fetch that lands
 * after its first render, so the hydration render matches the server's and
 * the rows count as fresh for the page that received them.
 */
function dehydrateInFlight(client: QueryClient): DehydratedState {
  const state = dehydrate(client, {
    shouldDehydrateQuery: (query) =>
      query.state.status === "success" || query.state.status === "pending",
  });
  return {
    ...state,
    queries: state.queries.map((query) =>
      query.queryKey[0] === agentCatalogQueryKeys.all[0] &&
      query.queryKey[1] === agentCatalogQueryKeys.all[1] &&
      query.state.status === "success"
        ? {
            ...query,
            state: { ...query.state, data: undefined, status: "pending" },
            promise: Promise.resolve(query.state.data),
          }
        : query,
    ),
  };
}
