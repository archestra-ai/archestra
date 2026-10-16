import { archestraApiSdk, type archestraApiTypes } from "@archestra/shared";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { throwOnApiError } from "@/lib/utils/api";

export type AgentOptionFilters = Omit<
  NonNullable<archestraApiTypes.GetAgentOptionsPageData["query"]>,
  "cursor" | "limit" | "search"
>;

/** Preserve get-or-create matching without downloading unrelated agents. */
export async function fetchInternalAgentOptionByName({
  name,
  authorId,
}: {
  name: string;
  authorId: string | undefined;
}) {
  if (!authorId) return undefined;
  const { data, error } = await archestraApiSdk.getAgentOptionsPage({
    query: {
      agentType: "agent",
      excludeBuiltIn: true,
      exactName: name,
      authorId,
      limit: 1,
    },
  });
  throwOnApiError(error, { toastOnError: false });
  return data?.data[0];
}

/** Fetch another page only after navigation; never drain the whole roster. */
export function useAgentOptionsPage({
  filters,
  search,
  enabled = true,
  limit = 20,
}: {
  filters?: AgentOptionFilters;
  search?: string;
  enabled?: boolean;
  limit?: number;
}) {
  const query = { excludeBuiltIn: true, ...filters, search, limit };
  return useInfiniteQuery({
    queryKey: ["agents", "options", "page", query],
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam }) => {
      const { data, error } = await archestraApiSdk.getAgentOptionsPage({
        query: { ...query, cursor: pageParam },
      });
      throwOnApiError(error, { toastOnError: false });
      if (!data) throw new Error("Agent options are unavailable");
      return data;
    },
    getNextPageParam: (page) => page.pagination.nextCursor ?? undefined,
    enabled,
  });
}

/** Names for explicit references, without fetching unrelated agents. */
export function useAgentOptionsByIds({
  ids,
  enabled = true,
}: {
  ids: readonly string[];
  enabled?: boolean;
}) {
  const uniqueIds = [...new Set(ids)].sort();
  return useQuery({
    queryKey: ["agents", "options", "ids", uniqueIds],
    queryFn: async () => {
      const options: archestraApiTypes.GetAgentOptionsResponses["200"] = [];
      for (let offset = 0; offset < uniqueIds.length; offset += 100) {
        const { data, error } = await archestraApiSdk.getAgentOptions({
          query: {
            ids: uniqueIds.slice(offset, offset + 100),
            excludeBuiltIn: false,
          },
        });
        throwOnApiError(error, { toastOnError: false });
        options.push(...(data ?? []));
      }
      return options;
    },
    enabled: enabled && uniqueIds.length > 0,
  });
}

/** Complete ID lookup for explicit bulk-selection/filtering actions only. */
export async function fetchAgentOptionIds(filters?: AgentOptionFilters) {
  const { data, error } = await archestraApiSdk.getAgentOptionIds({
    query: { excludeBuiltIn: true, ...filters },
  });
  throwOnApiError(error, { toastOnError: false });
  return data ?? [];
}

/** Explicit Select all needs IDs, never presentation data for the entire set. */
export function useAgentOptionIds({
  filters,
  enabled,
}: {
  filters?: AgentOptionFilters;
  enabled: boolean;
}) {
  return useQuery({
    queryKey: ["agents", "options", "all-ids", filters],
    queryFn: () => fetchAgentOptionIds(filters),
    enabled,
  });
}
