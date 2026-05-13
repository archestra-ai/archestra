"use client";

import { archestraApiSdk, type archestraApiTypes } from "@shared";
import { useQuery } from "@tanstack/react-query";
import { DEFAULT_TABLE_LIMIT } from "@/consts";
import { handleApiError } from "@/lib/utils";

const { getAuditLogs } = archestraApiSdk;

type AuditLogsQuery = NonNullable<archestraApiTypes.GetAuditLogsData["query"]>;
type AuditLogsResponse = archestraApiTypes.GetAuditLogsResponses["200"];

export type AuditLog = AuditLogsResponse["data"][number];
export type AuditAction = AuditLog["action"];

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
  sortBy = "createdAt",
  sortDirection = "desc",
  startDate,
  endDate,
  actorUserId,
  action,
  resourceType,
  search,
}: {
  limit?: number;
  offset?: number;
  sortBy?: AuditLogsQuery["sortBy"];
  sortDirection?: AuditLogsQuery["sortDirection"];
  startDate?: string;
  endDate?: string;
  actorUserId?: string;
  action?: AuditAction;
  resourceType?: string;
  search?: string;
} = {}) {
  return useQuery({
    queryKey: [
      ...AUDIT_LOG_QUERY_KEY,
      {
        limit,
        offset,
        sortBy,
        sortDirection,
        startDate,
        endDate,
        actorUserId,
        action,
        resourceType,
        search,
      },
    ],
    queryFn: async () => {
      const response = await getAuditLogs({
        query: {
          limit,
          offset,
          ...(sortBy ? { sortBy } : {}),
          ...(sortDirection ? { sortDirection } : {}),
          ...(startDate ? { startDate } : {}),
          ...(endDate ? { endDate } : {}),
          ...(actorUserId ? { actorUserId } : {}),
          ...(action ? { action } : {}),
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
