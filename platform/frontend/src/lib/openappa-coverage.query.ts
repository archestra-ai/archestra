import { archestraApiSdk, type archestraApiTypes } from "@archestra/shared";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { coverageQueryPrefix } from "@/lib/openappa-policy-views";
import { throwOnApiError } from "@/lib/utils";

export type CoverageSummary =
  archestraApiTypes.GetOpenappaCoverageSummaryResponses["200"];
export type CoverageServersPage =
  archestraApiTypes.GetOpenappaCoverageServersResponses["200"];
export type CoverageServer = CoverageServersPage["data"][number];
export type CoveragePosture = CoverageServer["posture"];
export type CoverageToolsPage =
  archestraApiTypes.GetOpenappaCoverageToolsResponses["200"];
export type CoverageTool = CoverageToolsPage["data"][number];
export type CoverageRule = NonNullable<CoverageTool["rule"]>;
export type CoverageAgentsPage =
  archestraApiTypes.GetOpenappaCoverageAgentsResponses["200"];
export type CoverageAgent = CoverageAgentsPage["data"][number];
export type CoverageServersParams = NonNullable<
  archestraApiTypes.GetOpenappaCoverageServersData["query"]
>;
export type CoverageToolsParams = NonNullable<
  archestraApiTypes.GetOpenappaCoverageToolsData["query"]
>;
export type CoverageAgentsParams = NonNullable<
  archestraApiTypes.GetOpenappaCoverageAgentsData["query"]
>;

/**
 * What the policy covers, read from the coverage endpoints: every key sits
 * under one prefix so a save, a pull or a tool sync refetches them all.
 */
export function useCoverageSummary() {
  return useQuery({
    queryKey: [coverageQueryPrefix, "summary"],
    queryFn: async () => {
      const { data, error } =
        await archestraApiSdk.getOpenappaCoverageSummary();
      throwOnApiError(error, { toastOnError: false });
      return data ?? null;
    },
  });
}

/** One page of servers, worst posture first. The previous page stays on screen while the next loads. */
export function useCoverageServers(params: CoverageServersParams) {
  return useQuery({
    queryKey: [coverageQueryPrefix, "servers", params],
    placeholderData: keepPreviousData,
    queryFn: async () => {
      const { data, error } = await archestraApiSdk.getOpenappaCoverageServers({
        query: params,
      });
      throwOnApiError(error, { toastOnError: false });
      return data ?? null;
    },
  });
}

/** One server's coverage; idle until a catalog entry is named. */
export function useCoverageServer(catalogId: string | null) {
  return useQuery({
    queryKey: [coverageQueryPrefix, "server", catalogId],
    enabled: catalogId !== null,
    queryFn: async () => {
      if (catalogId === null) return null;
      const { data, error } = await archestraApiSdk.getOpenappaCoverageServer({
        path: { catalogId },
      });
      throwOnApiError(error, { toastOnError: false });
      return data ?? null;
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

/** One page of agents, the one with the weakest reachable server first. */
export function useCoverageAgents(params: CoverageAgentsParams) {
  return useQuery({
    queryKey: [coverageQueryPrefix, "agents", params],
    placeholderData: keepPreviousData,
    queryFn: async () => {
      const { data, error } = await archestraApiSdk.getOpenappaCoverageAgents({
        query: params,
      });
      throwOnApiError(error, { toastOnError: false });
      return data ?? null;
    },
  });
}
