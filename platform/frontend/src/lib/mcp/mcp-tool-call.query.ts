"use client";

import { archestraApiSdk, type archestraApiTypes } from "@archestra/shared";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import type { CallerIdentity } from "@/components/executed-as-badge";
import { DEFAULT_TABLE_LIMIT } from "@/consts";
import { throwOnApiError } from "@/lib/utils/api";

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
    case "service_account_token":
      return "Service Account";
    case "external_idp":
      return "External IdP";
    case "session":
      return "Session";
  }
}

/**
 * Who a tool call ran on behalf of, for the calls the platform served itself.
 * A call made with a gateway token carries no user, and an auditor still needs
 * an identity for it: the token acts for its team or for the organization, so
 * that is who made the call. A service account normally carries its own name;
 * one that has since been deleted still reads as a service account rather than
 * an unknown caller. The auth method stays visible in its own column.
 */
export function formatCallerIdentity(row: {
  userName: string | null;
  authMethod: MCPGatewayAuthMethod | null;
}): CallerIdentity | null {
  if (row.userName) {
    return { name: row.userName, scope: "personal" };
  }
  switch (row.authMethod) {
    case "org_token":
      return { name: null, scope: "org" };
    case "team_token":
      return { name: null, scope: "team" };
    case "service_account_token":
      return { name: "Service account", scope: "org" };
    default:
      // Every other method authenticates a person, so a missing name means the
      // user is gone — there is nothing to name them by.
      return null;
  }
}

const { getMcpToolCall, getMcpToolCalls } = archestraApiSdk;

export function useMcpToolCalls({
  agentId,
  mcpServerName,
  userId,
  startDate,
  endDate,
  limit = DEFAULT_TABLE_LIMIT,
  cursor,
  enabled = true,
}: {
  agentId?: string;
  mcpServerName?: string;
  userId?: string;
  startDate?: string;
  endDate?: string;
  limit?: number;
  cursor?: string;
  enabled?: boolean;
} = {}) {
  return useQuery({
    queryKey: [
      "mcpToolCalls",
      agentId,
      mcpServerName,
      userId,
      startDate,
      endDate,
      limit,
      cursor,
    ],
    // A new page or a minute tick keeps the rows on screen until the
    // answer lands, so the table never blanks and loses its scroll.
    placeholderData: keepPreviousData,
    queryFn: async () => {
      const response = await getMcpToolCalls({
        query: {
          ...(agentId ? { agentId } : {}),
          ...(mcpServerName ? { mcpServerName } : {}),
          ...(userId ? { userId } : {}),
          ...(startDate ? { startDate } : {}),
          ...(endDate ? { endDate } : {}),
          limit,
          ...(cursor ? { cursor } : {}),
        },
      });
      // Screen renders its own QueryLoadError panel; don't also toast.
      throwOnApiError(response.error, { toastOnError: false });
      return (
        response.data ?? {
          data: [],
          pagination: {
            limit,
            nextCursor: null,
            hasNext: false,
          },
        }
      );
    },
    enabled,
  });
}

export function useMcpToolCall({
  mcpToolCallId,
  enabled = true,
}: {
  mcpToolCallId: string;
  enabled?: boolean;
}) {
  return useQuery({
    queryKey: ["mcpToolCalls", mcpToolCallId],
    queryFn: async () => {
      const response = await getMcpToolCall({ path: { mcpToolCallId } });
      throwOnApiError(response.error, { allowNotFound: true });
      return response.data ?? null;
    },
    enabled,
  });
}

/**
 * The MCP tool calls an LLM session issued within one time window, newest
 * first: the session page lays them on the same axis as the requests it
 * shows. One page of the largest size, since a window spans one page of
 * requests; `pagination.hasNext` says when it holds more than that.
 */
export function useSessionMcpToolCalls({
  sessionId,
  startDate,
  endDate,
  enabled = true,
}: {
  sessionId: string;
  startDate?: string;
  endDate?: string;
  enabled?: boolean;
}) {
  return useQuery({
    queryKey: ["mcpToolCalls", "session", sessionId, startDate, endDate],
    queryFn: async () => {
      const response = await getMcpToolCalls({
        query: {
          sessionId,
          ...(startDate ? { startDate } : {}),
          ...(endDate ? { endDate } : {}),
          limit: SESSION_TOOL_CALLS_LIMIT,
        },
      });
      throwOnApiError(response.error);
      return (
        response.data ?? {
          data: [],
          pagination: {
            limit: SESSION_TOOL_CALLS_LIMIT,
            nextCursor: null,
            hasNext: false,
          },
        }
      );
    },
    enabled,
  });
}

/** The list endpoint's largest page. */
const SESSION_TOOL_CALLS_LIMIT = 100;
