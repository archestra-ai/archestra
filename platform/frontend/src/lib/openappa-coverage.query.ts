import { archestraApiSdk, type archestraApiTypes } from "@archestra/shared";
import {
  keepPreviousData,
  queryOptions,
  useQueries,
  useQuery,
} from "@tanstack/react-query";
import { coverageQueryPrefix } from "@/lib/openappa-policy-views";
import { throwOnApiError } from "@/lib/utils";

type CoverageToolsPage =
  archestraApiTypes.GetOpenappaCoverageToolsResponses["200"];
export type CoverageTool = CoverageToolsPage["data"][number];
type CoverageEntitiesPage =
  archestraApiTypes.GetOpenappaCoverageEntitiesResponses["200"];
export type CoverageEntity = CoverageEntitiesPage["data"][number];
export type CoverageToolsParams = NonNullable<
  archestraApiTypes.GetOpenappaCoverageToolsData["query"]
>;
export type CoverageEntitiesParams = NonNullable<
  archestraApiTypes.GetOpenappaCoverageEntitiesData["query"]
>;

/** Share one cache key and error path for both entity views. */
function coverageEntitiesQueryOptions(params: CoverageEntitiesParams) {
  return queryOptions({
    queryKey: [coverageQueryPrefix, "entities", params],
    queryFn: async () => {
      const { data, error } = await archestraApiSdk.getOpenappaCoverageEntities(
        {
          query: params,
        },
      );
      throwOnApiError(error, { toastOnError: false });
      return data ?? null;
    },
  });
}

/** One page of visible agents, gateways, and registry servers with tool counts. */
export function useCoverageEntities(params: CoverageEntitiesParams) {
  return useQuery({
    ...coverageEntitiesQueryOptions(params),
    placeholderData: keepPreviousData,
  });
}

/**
 * The policy targets that reach any of these tools, each with the tools it
 * reaches: one entities request per tool, merged by target.
 */
export function useCoverageEntitiesForTools(toolIds: string[]) {
  return useQueries({
    queries: toolIds.map((toolId) => {
      const params: CoverageEntitiesParams = { toolId, limit: 100, offset: 0 };
      return coverageEntitiesQueryOptions(params);
    }),
    combine: (results) => {
      const byId = new Map<
        string,
        { entity: CoverageEntity; toolIds: string[] }
      >();
      results.forEach((result, index) => {
        for (const entity of result.data?.data ?? []) {
          const entry = byId.get(entity.id) ?? { entity, toolIds: [] };
          entry.toolIds.push(toolIds[index]);
          byId.set(entity.id, entry);
        }
      });
      return {
        targets: [...byId.values()],
        isPending: results.some((result) => result.isPending),
        isError: results.some((result) => result.isError),
        refetch: () => results.forEach((result) => void result.refetch()),
      };
    },
  });
}

/** One page of tool rows, unlisted first, then not enforced, then enforced. */
export function useCoverageTools(params: CoverageToolsParams) {
  return useQuery({
    queryKey: [coverageQueryPrefix, "tools", params],
    placeholderData: keepPreviousData,
    queryFn: async () => {
      const { data, error } = await archestraApiSdk.getOpenappaCoverageTools({
        query: params,
      });
      throwOnApiError(error, { toastOnError: false });
      return data ?? null;
    },
  });
}

/** Every tool of one catalog, read page by page, for pickers that search them all. */
export function useAllCoverageTools(catalogId: string) {
  return useQuery(allCoverageToolsQueryOptions(catalogId));
}

function allCoverageToolsQueryOptions(catalogId: string, enabled = true) {
  return queryOptions({
    queryKey: [coverageQueryPrefix, "tools", "all", catalogId],
    enabled,
    queryFn: async () => {
      const rows: CoverageTool[] = [];
      for (let offset = 0; ; offset += 100) {
        const { data, error } = await archestraApiSdk.getOpenappaCoverageTools({
          query: { catalogId, limit: 100, offset },
        });
        throwOnApiError(error, { toastOnError: false });
        if (!data) break;
        rows.push(...data.data);
        if (!data.pagination.hasNext) break;
      }
      return rows;
    },
  });
}

/** All tool rows from the selected catalogs, sharing cached all-tools results. */
export function useAllCoverageToolsForCatalogs(
  catalogIds: string[],
  { enabled = true }: { enabled?: boolean } = {},
) {
  return useQueries({
    queries: catalogIds.map((catalogId) =>
      allCoverageToolsQueryOptions(catalogId, enabled),
    ),
    combine: (results) => ({
      tools: results.flatMap((result) => result.data ?? []),
      isPending: results.some((result) => result.isPending),
      isError: results.some((result) => result.isError),
      refetch: () => results.forEach((result) => void result.refetch()),
    }),
  });
}
