import {
  archestraApiSdk,
  type archestraApiTypes,
  MAX_BULK_IDS,
} from "@archestra/shared";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import {
  agentCatalogListQuery,
  agentCatalogQueryKeys,
} from "@/lib/agent-catalog.keys";
import { useAllMatching } from "@/lib/hooks/use-all-matching";
import {
  DEFAULT_STALE_TIME,
  PERSISTED_QUERY_META,
} from "@/lib/query-persistence";
import { streamedQueries } from "@/lib/streamed-queries";
import { throwOnApiError } from "@/lib/utils/api";

const { getAgentCatalog } = archestraApiSdk;

export {
  agentCatalogListQuery,
  agentCatalogQueryKeys,
} from "@/lib/agent-catalog.keys";

export function useAgentCatalog(
  params?: archestraApiTypes.GetAgentCatalogData["query"] & {
    enabled?: boolean;
  },
) {
  const { enabled, ...rest } = params ?? {};
  const query = agentCatalogListQuery(rest);
  const [mountedAt] = useState(Date.now);

  return useQuery({
    queryKey: agentCatalogQueryKeys.list(query),
    queryFn: async () => {
      const { data, error } = await getAgentCatalog({ query });
      throwOnApiError(error, { toastOnError: false });
      return data ?? null;
    },
    // A restored or earlier catalog may predate a creation or deletion: paint
    // it at once, then revalidate it on mount. A catalog that the server
    // streamed to this page, or that arrived after this mount, is as fresh as
    // any query. One stamped in the mount's own millisecond counts as earlier.
    staleTime: (catalog) =>
      streamedQueries.has(catalog) || catalog.state.dataUpdatedAt > mountedAt
        ? DEFAULT_STALE_TIME
        : 0,
    enabled,
    meta: PERSISTED_QUERY_META,
  });
}

export function useAllMatchingAgentCatalog(
  query: Omit<
    NonNullable<archestraApiTypes.GetAgentCatalogData["query"]>,
    "limit" | "offset"
  >,
  options?: { enabled?: boolean },
) {
  return useAllMatching({
    queryKey: [...agentCatalogQueryKeys.all, "all-matching", query],
    enabled: options?.enabled,
    max: MAX_BULK_IDS + 1,
    fetchPage: async ({ limit, offset }) => {
      const { data, error } = await getAgentCatalog({
        query: {
          ...query,
          includeTools: false,
          selectableOnly: true,
          limit,
          offset,
        },
      });
      throwOnApiError(error, { toastOnError: false });
      return data?.data ?? [];
    },
  });
}
