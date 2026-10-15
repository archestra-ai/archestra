"use client";
import { archestraApiSdk, type archestraApiTypes } from "@archestra/shared";
import { useQuery } from "@tanstack/react-query";
import { createContext, type ReactNode, useContext } from "react";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { throwOnApiError } from "@/lib/utils/api";

type UsagePage =
  archestraApiTypes.GetMcpServerAgentUsageResponses["200"][number];
const UsageSummaries = createContext<Map<string, UsagePage> | undefined>(
  undefined,
);

export function useMcpServerAgentUsage(params: {
  catalogIds: string[];
  enabled?: boolean;
  limit?: number;
  offset?: number;
  search?: string;
  sortDirection?: "asc" | "desc";
  previews?: boolean;
}) {
  const { data: allowed } = useHasPermissions({
    mcpServerInstallation: ["read"],
  });
  const { enabled = true, previews = false, ...query } = params;
  return useQuery({
    queryKey: ["mcp-servers", "agent-usage", query, previews],
    queryFn: async ({ signal }) => {
      const { data, error } = await archestraApiSdk.getMcpServerAgentUsage({
        query: { ...query, previews: previews ? "true" : "false" },
        querySerializer: { array: { style: "form", explode: false } },
        signal,
      });
      throwOnApiError(error, { toastOnError: false });
      return data ?? [];
    },
    enabled: enabled && !!allowed && params.catalogIds.length > 0,
    staleTime: 30_000,
  });
}

export function McpUsageSummaryProvider({
  catalogIds,
  children,
}: {
  catalogIds: string[];
  children: ReactNode;
}) {
  const { data: allowed } = useHasPermissions({
    mcpServerInstallation: ["update"],
  });
  const { data } = useMcpServerAgentUsage({
    catalogIds,
    enabled: !!allowed,
    limit: 8,
    previews: true,
  });
  return (
    <UsageSummaries
      value={new Map(data?.map((entry) => [entry.catalogId, entry]))}
    >
      {children}
    </UsageSummaries>
  );
}

export function useMcpUsageSummary(catalogId: string) {
  return useContext(UsageSummaries)?.get(catalogId);
}
