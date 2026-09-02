"use client";

import { archestraApiSdk, type archestraApiTypes } from "@archestra/shared";
import { useQuery } from "@tanstack/react-query";
import { DEFAULT_TABLE_LIMIT } from "@/consts";
import { throwOnApiError } from "@/lib/utils";

const { getAuditLogs, getAuditLog } = archestraApiSdk;

type AuditLogsQuery = NonNullable<archestraApiTypes.GetAuditLogsData["query"]>;
type AuditLogsResponse = archestraApiTypes.GetAuditLogsResponses["200"];

export type AuditLog = AuditLogsResponse["data"][number];
// Derived from the query filter enum, not the response: the response `action`
// is deliberately open (accepts unknown legacy names), so only the query side
// carries the strict catalog of known event names.
export type AuditEventName = NonNullable<AuditLogsQuery["action"]>;
export type AuditActorType = AuditLog["actorType"];
export type AuditOutcome = AuditLog["outcome"];

export const AUDIT_LOG_QUERY_KEY = ["audit-logs"] as const;

const EMPTY_RESPONSE = (limit: number): AuditLogsResponse => ({
  data: [],
  pagination: {
    limit,
    nextCursor: null,
    hasNext: false,
  },
});

export function useAuditLogs({
  limit = DEFAULT_TABLE_LIMIT,
  cursor,
  startDate,
  endDate,
  actorId,
  action,
  outcome,
  actorType,
  resourceType,
  resourceId,
}: {
  limit?: number;
  cursor?: string;
  startDate?: string;
  endDate?: string;
  actorId?: string;
  action?: AuditEventName;
  outcome?: AuditOutcome;
  actorType?: AuditActorType;
  resourceType?: string;
  resourceId?: string;
} = {}) {
  return useQuery({
    queryKey: [
      ...AUDIT_LOG_QUERY_KEY,
      {
        limit,
        cursor,
        startDate,
        endDate,
        actorId,
        action,
        outcome,
        actorType,
        resourceType,
        resourceId,
      },
    ],
    queryFn: async () => {
      const response = await getAuditLogs({
        query: {
          limit,
          ...(cursor ? { cursor } : {}),
          ...(startDate ? { startDate } : {}),
          ...(endDate ? { endDate } : {}),
          ...(actorId ? { actorId } : {}),
          ...(action ? { action } : {}),
          ...(outcome ? { outcome } : {}),
          ...(actorType ? { actorType } : {}),
          ...(resourceType ? { resourceType } : {}),
          ...(resourceId ? { resourceId } : {}),
        },
      });
      // Screen renders its own QueryLoadError panel; don't also toast.
      throwOnApiError(response.error, { toastOnError: false });
      return response.data ?? EMPTY_RESPONSE(limit);
    },
  });
}

export function useAuditLog(id: string | undefined) {
  return useQuery({
    queryKey: [...AUDIT_LOG_QUERY_KEY, id],
    queryFn: async () => {
      if (!id) return null;
      const response = await getAuditLog({ path: { id } });
      throwOnApiError(response.error, {
        allowNotFound: true,
        toastOnError: false,
      });
      return response.data ?? null;
    },
    enabled: !!id,
  });
}
