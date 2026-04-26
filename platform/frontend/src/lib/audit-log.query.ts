"use client";

import { archestraApiSdk, type archestraApiTypes } from "@shared";
import { useQuery } from "@tanstack/react-query";

const { getAuditLogs } = archestraApiSdk;

export type AuditLogEntry = archestraApiTypes.AuditLogEntry;

export type AuditLogsFilters = {
  actorId?: string;
  resourceType?: string;
  action?: string;
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
};

export function useAuditLogs(filters: AuditLogsFilters = {}) {
  return useQuery({
    queryKey: ["audit-logs", filters],
    queryFn: async () => {
      const response = await getAuditLogs({ query: filters });
      return response.data ?? null;
    },
    staleTime: 30 * 1000, // 30 seconds
  });
}
