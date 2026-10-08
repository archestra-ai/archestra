import { archestraApiSdk, type archestraApiTypes } from "@archestra/shared";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { coverageQueryPrefix } from "@/lib/openappa-policy-views";
import { throwOnApiError } from "@/lib/utils/api";

type CoverageToolsPage =
  archestraApiTypes.GetOpenappaCoverageToolsResponses["200"];
export type CoverageTool = CoverageToolsPage["data"][number];
type CoverageEntitiesPage =
  archestraApiTypes.GetOpenappaCoverageEntitiesResponses["200"];
/** A row of the entities list: a registry server with coverage, or a detected server. */
export type CoverageEntity = CoverageEntitiesPage["data"][number];
export type DetectedCoverageEntity = Extract<
  CoverageEntity,
  { type: "detected_mcp_server" }
>;
export type RegistryCoverageEntity = Exclude<
  CoverageEntity,
  DetectedCoverageEntity
>;
export type CoverageRuleCounts = RegistryCoverageEntity["rules"];
export type CoverageSummary =
  archestraApiTypes.GetOpenappaCoverageSummaryResponses["200"];
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
export function useCoverageEntities(
  params: CoverageEntitiesParams,
  { enabled = true }: { enabled?: boolean } = {},
) {
  return useQuery({
    queryKey: [coverageQueryPrefix, "entities", params],
    enabled,
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

/** The whole visible tool inventory in aggregate, for the Overview charts. */
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

/**
 * The servers people connected directly to their coding clients, as the
 * Guardrails list shows them: the detected rows of the entities endpoint.
 * Bounded by the endpoint's page size, which is more than an organization's
 * client labels.
 */
export function useDetectedMcpServers({ enabled = true } = {}) {
  return useQuery({
    queryKey: [coverageQueryPrefix, "entities", "detected"],
    enabled,
    queryFn: async () => {
      const { data, error } = await archestraApiSdk.getOpenappaCoverageEntities(
        { query: { type: "detected_mcp_server", limit: 100, offset: 0 } },
      );
      throwOnApiError(error, { toastOnError: false });
      return (data?.data ?? []).filter(
        (entity): entity is DetectedCoverageEntity =>
          entity.type === "detected_mcp_server",
      );
    },
  });
}
