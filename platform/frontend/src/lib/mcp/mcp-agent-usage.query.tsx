"use client";
import { archestraApiSdk, type archestraApiTypes } from "@archestra/shared";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { throwOnApiError } from "@/lib/utils/api";

type AssignedAgent = Omit<
  NonNullable<
    archestraApiTypes.GetMcpServersResponses["200"][number]["assignedAgents"]
  >[number],
  "pinned"
>;

export function useMcpAutoAgents(params: {
  catalogId?: string;
  enabled?: boolean;
  limit?: number;
  cursor?: string;
  afterAgentId?: string;
  search?: string;
  sortDirection?: "asc" | "desc";
  summary?: boolean;
}) {
  const { data: allowed } = useHasPermissions({
    mcpServerInstallation: ["read"],
  });
  const { enabled = true, summary = false, ...input } = params;
  const query = { ...input, search: input.search || undefined };
  return useQuery({
    queryKey: ["mcp-servers", "automatic-agent-usage", query, summary],
    queryFn: async ({ signal }) => {
      const { data, error } =
        await archestraApiSdk.getMcpServerAutoModeAgentPage({
          query: { ...query, summary: summary ? "true" : "false" },
          signal,
        });
      throwOnApiError(error, { toastOnError: false });
      return data;
    },
    enabled: enabled && !!allowed,
    staleTime: 30_000,
  });
}

/** Exact counts use the explicit metadata the caller already loaded. */
export function useMcpUsageSummary({
  catalogId,
  assignedAgents,
  enabled = true,
  previews = true,
  search,
}: {
  catalogId: string;
  assignedAgents: AssignedAgent[];
  enabled?: boolean;
  previews?: boolean;
  search?: string;
}) {
  const summary = useMcpAutoAgents({ summary: true, enabled, search });
  const overlap = assignedAgents.filter(
    (agent) =>
      agent.accessAllTools &&
      agent.organizationId === summary.data?.organizationId,
  ).length;
  const autoCount = Math.max(0, (summary.data?.totalAutoCount ?? 0) - overlap);
  const globalPreview = useMcpAutoAgents({
    limit: 100,
    enabled: enabled && previews && summary.isSuccess && autoCount > 0,
    search,
  });
  const assignedIds = useMemo(
    () =>
      new Set(
        previews && autoCount > 0
          ? assignedAgents.map((agent) => agent.id)
          : [],
      ),
    [assignedAgents, previews, autoCount],
  );
  const sharedCandidates =
    globalPreview.data?.data.filter((agent) => !assignedIds.has(agent.id)) ??
    [];
  const sharedComplete =
    globalPreview.isSuccess &&
    (sharedCandidates.length >= 8 || !globalPreview.data?.pagination.hasNext);
  const preview = useMcpAutoAgents({
    catalogId,
    limit: 8,
    search,
    enabled:
      enabled &&
      previews &&
      summary.isSuccess &&
      autoCount > 0 &&
      globalPreview.isSuccess &&
      !sharedComplete,
  });
  const automaticPreview = sharedComplete
    ? sharedCandidates.slice(0, 8)
    : (preview.data?.data ?? []);
  return {
    ...summary,
    data: summary.data
      ? {
          assignedCount: assignedAgents.length,
          autoCount,
          pagination: { total: assignedAgents.length + autoCount },
          assignedPreview: assignedAgents
            .slice(0, 8)
            .map((agent) => ({ ...agent, access: "assigned" as const })),
          autoPreview: automaticPreview.map((agent) => ({
            ...agent,
            access: "auto" as const,
          })),
        }
      : undefined,
  };
}
