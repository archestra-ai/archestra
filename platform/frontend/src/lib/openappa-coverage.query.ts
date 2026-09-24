import { archestraApiSdk, type archestraApiTypes } from "@archestra/shared";
import { keepPreviousData, useQueries, useQuery } from "@tanstack/react-query";
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

/**
 * What the policy covers, read from the coverage endpoints: every key sits
 * under one prefix so a save, a pull or a tool sync refetches them all.
 */
/** One page of visible agents, gateways, and registry servers with tool counts. */
export function useCoverageEntities(params: CoverageEntitiesParams) {
  return useQuery({
    queryKey: [coverageQueryPrefix, "entities", params],
    placeholderData: keepPreviousData,
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

/**
 * The policy targets that reach any of these tools, each with the tools it
 * reaches: one entities request per tool, merged by target.
 */
export function useCoverageEntitiesForTools(toolIds: string[]) {
  return useQueries({
    queries: toolIds.map((toolId) => {
      const params: CoverageEntitiesParams = { toolId, limit: 100, offset: 0 };
      return {
        queryKey: [coverageQueryPrefix, "entities", params],
        queryFn: async () => {
          const { data, error } =
            await archestraApiSdk.getOpenappaCoverageEntities({
              query: params,
            });
          throwOnApiError(error, { toastOnError: false });
          return data ?? null;
        },
      };
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
  return useQuery({
    queryKey: [coverageQueryPrefix, "tools", "all", catalogId],
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
