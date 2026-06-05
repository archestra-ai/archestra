"use client";

import { archestraApiSdk, type archestraApiTypes } from "@archestra/shared";
import { useQuery } from "@tanstack/react-query";
import { DEFAULT_TABLE_LIMIT } from "@/consts";
import { handleApiError } from "@/lib/utils";

const { getAuditLogs } = archestraApiSdk;

type AuditLogsQuery = NonNullable<archestraApiTypes.GetAuditLogsData["query"]>;
type AuditLogsResponse = archestraApiTypes.GetAuditLogsResponses["200"];

export type AuditLog = AuditLogsResponse["data"][number];
export type AuditEventName = AuditLog["action"];
export type AuditActorType = AuditLog["actorType"];
export type AuditOutcome = AuditLog["outcome"];

export const AUDIT_LOG_QUERY_KEY = ["audit-logs"] as const;

const EMPTY_RESPONSE = (limit: number): AuditLogsResponse => ({
  data: [],
  pagination: {
    currentPage: 1,
    limit,
    total: 0,
    totalPages: 0,
    hasNext: false,
    hasPrev: false,
  },
});

export function useAuditLogs({
  limit = DEFAULT_TABLE_LIMIT,
  offset = 0,
  sortDirection = "desc",
  startDate,
  endDate,
  actorId,
  action,
  outcome,
  actorType,
  resourceType,
  search,
}: {
  limit?: number;
  offset?: number;
  sortDirection?: AuditLogsQuery["sortDirection"];
  startDate?: string;
  endDate?: string;
  actorId?: string;
  action?: AuditEventName;
  outcome?: AuditOutcome;
  actorType?: AuditActorType;
  resourceType?: string;
  search?: string;
} = {}) {
  return useQuery({
    queryKey: [
      ...AUDIT_LOG_QUERY_KEY,
      {
        limit,
        offset,
        sortDirection,
        startDate,
        endDate,
        actorId,
        action,
        outcome,
        actorType,
        resourceType,
        search,
      },
    ],
    queryFn: async () => {
      const response = await getAuditLogs({
        query: {
          limit,
          offset,
          ...(sortDirection ? { sortDirection } : {}),
          ...(startDate ? { startDate } : {}),
          ...(endDate ? { endDate } : {}),
          ...(actorId ? { actorId } : {}),
          ...(action ? { action } : {}),
          ...(outcome ? { outcome } : {}),
          ...(actorType ? { actorType } : {}),
          ...(resourceType ? { resourceType } : {}),
          ...(search ? { search } : {}),
        },
      });
      if (response.error) {
        handleApiError(response.error);
        return EMPTY_RESPONSE(limit);
      }
      return response.data ?? EMPTY_RESPONSE(limit);
    },
  });
}
