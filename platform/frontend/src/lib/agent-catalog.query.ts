import {
  archestraApiSdk,
  type archestraApiTypes,
  MAX_BULK_IDS,
} from "@archestra/shared";
import { useQuery } from "@tanstack/react-query";
import {
  DEFAULT_SORT_BY,
  DEFAULT_SORT_DIRECTION,
  DEFAULT_TABLE_LIMIT,
} from "@/consts";
import { useAllMatching } from "@/lib/hooks/use-all-matching";
import { PERSISTED_QUERY_META } from "@/lib/query-persistence";
import { throwOnApiError } from "@/lib/utils";

const { getAgentCatalog } = archestraApiSdk;

export const agentCatalogQueryKeys = {
  all: ["agents", "catalog"] as const,
  list: (query: archestraApiTypes.GetAgentCatalogData["query"]) =>
    [...agentCatalogQueryKeys.all, query] as const,
};

export function useAgentCatalog(
  params?: archestraApiTypes.GetAgentCatalogData["query"] & {
    initialData?: archestraApiTypes.GetAgentCatalogResponses["200"];
    initialDataExcludeOtherPersonalAgents?: boolean;
  },
) {
  const { initialData, initialDataExcludeOtherPersonalAgents, ...query } =
    params ?? {};
  const useInitialData =
    query.offset === 0 &&
    (query.sortBy === undefined || query.sortBy === DEFAULT_SORT_BY) &&
    (query.sortDirection === undefined ||
      query.sortDirection === DEFAULT_SORT_DIRECTION) &&
    query.name === undefined &&
    query.scope === undefined &&
    query.teamIds === undefined &&
    query.authorIds === undefined &&
    query.excludeAuthorIds === undefined &&
    query.excludeOtherPersonalAgents ===
      initialDataExcludeOtherPersonalAgents &&
    query.labels === undefined &&
    query.status === undefined &&
    query.providerApiKeyId === undefined &&
    (query.limit === undefined || query.limit === DEFAULT_TABLE_LIMIT);

  return useQuery({
    queryKey: agentCatalogQueryKeys.list(query),
    queryFn: async () => {
      const { data, error } = await getAgentCatalog({ query });
      throwOnApiError(error, { toastOnError: false });
      return data ?? null;
    },
    initialData: useInitialData ? initialData : undefined,
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
        query: { ...query, selectableOnly: true, limit, offset },
      });
      throwOnApiError(error, { toastOnError: false });
      return data?.data ?? [];
    },
  });
}
