"use client";

import { archestraApiSdk, type archestraApiTypes } from "@shared";
import { useSuspenseQuery } from "@tanstack/react-query";
import { DEFAULT_TABLE_LIMIT } from "./utils";

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
  return useSuspenseQuery({
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
        throw new Error(
          response.error.error?.message ?? "Failed to fetch MCP tool calls",
        );
      }
      if (!response.data) {
        throw new Error("Failed to fetch MCP tool calls");
      }
      return response.data;
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
  return useSuspenseQuery({
    queryKey: ["mcpToolCalls", mcpToolCallId],
    queryFn: async () => {
      const response = await getMcpToolCall({ path: { mcpToolCallId } });
      if (response.error) {
        throw new Error(
          response.error.error?.message ?? "Failed to fetch MCP tool call",
        );
      }
      if (!response.data) {
        throw new Error("Failed to fetch MCP tool call");
      }
      return response.data;
    },
    initialData,
  });
}
