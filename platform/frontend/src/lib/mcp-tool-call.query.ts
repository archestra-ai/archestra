"use client";

import { archestraApiSdk, type archestraApiTypes } from "@shared";
import { useQuery } from "@tanstack/react-query";
import { DEFAULT_TABLE_LIMIT, handleApiError } from "./utils";

type MCPGatewayAuthMethod =
  archestraApiTypes.GetMcpToolCallResponses["200"]["authMethod"];

export function formatAuthMethod(authMethod: MCPGatewayAuthMethod): string {
  switch (authMethod) {
    case "oauth":
      return "OAuth";
    case "user_token":
      return "User Token";
    case "org_token":
      return "Org Token";
    case "team_token":
      return "Team Token";
    case "external_idp":
      return "External IdP";
  }
}

const { getMcpToolCall, getMcpToolCalls } = archestraApiSdk;

export function useMcpToolCalls({
  agentId,
  startDate,
  endDate,
  search,
  limit = DEFAULT_TABLE_LIMIT,
  offset = 0,
  sortBy,
  sortDirection = "desc",
  initialData,
}: {
  agentId?: string;
  startDate?: string;
  endDate?: string;
  search?: string;
  limit?: number;
  offset?: number;
  sortBy?: NonNullable<
    archestraApiTypes.GetMcpToolCallsData["query"]
  >["sortBy"];
  sortDirection?: "asc" | "desc";
  initialData?: archestraApiTypes.GetMcpToolCallsResponses["200"];
} = {}) {
  return useQuery({
    queryKey: [
      "mcpToolCalls",
      agentId,
      startDate,
      endDate,
      search,
      limit,
      offset,
      sortBy,
      sortDirection,
    ],
    queryFn: async () => {
      const response = await getMcpToolCalls({
        query: {
          ...(agentId ? { agentId } : {}),
          ...(startDate ? { startDate } : {}),
          ...(endDate ? { endDate } : {}),
          ...(search ? { search } : {}),
          limit,
          offset,
          ...(sortBy ? { sortBy } : {}),
          sortDirection,
        },
      });
      if (response.error) {
        handleApiError(response.error);
        return {
          data: [],
          pagination: {
            currentPage: 1,
            limit,
            total: 0,
            totalPages: 0,
            hasNext: false,
            hasPrev: false,
          },
        };
      }
      return (
        response.data ?? {
          data: [],
          pagination: {
            currentPage: 1,
            limit,
            total: 0,
            totalPages: 0,
            hasNext: false,
            hasPrev: false,
          },
        }
      );
    },
    // Only use initialData for the first page (offset 0) with default sorting and default limit
    initialData:
      offset === 0 &&
      limit === DEFAULT_TABLE_LIMIT &&
      sortBy === "createdAt" &&
      sortDirection === "desc" &&
      !startDate &&
      !endDate &&
      !search
        ? initialData
        : undefined,
  });
}

export function useMcpToolCall({
  mcpToolCallId,
  initialData,
}: {
  mcpToolCallId: string;
  initialData?: archestraApiTypes.GetMcpToolCallResponses["200"];
}) {
  return useQuery({
    queryKey: ["mcpToolCalls", mcpToolCallId],
    queryFn: async () => {
      const response = await getMcpToolCall({ path: { mcpToolCallId } });
      if (response.error) {
        handleApiError(response.error);
        return null;
      }
      return response.data ?? null;
    },
    initialData,
  });
}
