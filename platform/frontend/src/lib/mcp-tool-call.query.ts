"use client";

import { archestraApiSdk, type archestraApiTypes } from "@archestra/shared";
import { useSuspenseQuery } from "@tanstack/react-query";
import { DEFAULT_TABLE_LIMIT } from "./utils";

const { getMcpToolCall, getMcpToolCalls } = archestraApiSdk;

export function useMcpToolCalls({
  agentId,
  limit = DEFAULT_TABLE_LIMIT,
  offset = 0,
  sortBy,
  sortDirection = "desc",
  initialData,
}: {
  agentId?: string;
  limit?: number;
  offset?: number;
  sortBy?: NonNullable<
    archestraApiTypes.GetMcpToolCallsData["query"]
  >["sortBy"];
  sortDirection?: "asc" | "desc";
  initialData?: archestraApiTypes.GetMcpToolCallsResponses["200"];
} = {}) {
  return useSuspenseQuery({
    queryKey: ["mcpToolCalls", agentId, limit, offset, sortBy, sortDirection],
    queryFn: async () => {
      const response = await getMcpToolCalls({
        query: {
          ...(agentId ? { agentId } : {}),
          limit,
          offset,
          ...(sortBy ? { sortBy } : {}),
          sortDirection,
        },
      });
      return response.data;
    },
    // Only use initialData for the first page (offset 0) with default sorting and default limit
    initialData:
      offset === 0 &&
      limit === DEFAULT_TABLE_LIMIT &&
      sortBy === "createdAt" &&
      sortDirection === "desc"
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
  return useSuspenseQuery({
    queryKey: ["mcpToolCalls", mcpToolCallId],
    queryFn: async () => {
      const response = await getMcpToolCall({ path: { mcpToolCallId } });
      return response.data;
    },
    initialData,
  });
}
