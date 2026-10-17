"use client";

import { archestraApiSdk, type archestraApiTypes } from "@archestra/shared";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { DEFAULT_TABLE_LIMIT } from "@/consts";
import { useDebouncedValue } from "@/lib/hooks/use-debounced-value";
import { throwOnApiError } from "@/lib/utils/api";

const { getAuditLogs, getAuditLog, getAuditLogResources } = archestraApiSdk;

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

/**
 * Options for the audit log's resource filter, searched on the server. The
 * option list loads only when `enabled` is true (the picker has opened). The
 * selected resource loads on its own, so a filter restored from the URL keeps
 * its name.
 */
export function useAuditLogResourceSearch(params: {
  enabled: boolean;
  selectedResourceId?: string;
}) {
  const [searchQuery, setSearchQuery] = useState("");
  const search = useDebouncedValue(searchQuery.trim(), 250);
  const options = useQuery({
    queryKey: [...AUDIT_LOG_QUERY_KEY, "resources", { search }],
    queryFn: async () => {
      const { data, error } = await getAuditLogResources({
        query: { search: search || undefined, limit: RESOURCE_OPTION_LIMIT },
      });
      throwOnApiError(error, { toastOnError: false });
      return data?.data ?? [];
    },
    enabled: params.enabled,
    placeholderData: keepPreviousData,
  });
  const selectedId = params.selectedResourceId;
  const selected = useQuery({
    queryKey: [...AUDIT_LOG_QUERY_KEY, "resources", { resourceId: selectedId }],
    queryFn: async () => {
      const { data, error } = await getAuditLogResources({
        query: { resourceId: selectedId, limit: 1 },
      });
      throwOnApiError(error, { toastOnError: false });
      return data?.data ?? [];
    },
    enabled:
      !!selectedId &&
      !options.data?.some((option) => option.resourceId === selectedId),
  });
  return {
    options: options.data ?? [],
    selected:
      options.data?.find((option) => option.resourceId === selectedId) ??
      selected.data?.[0],
    onSearchQueryChange: setSearchQuery,
    isSearching: searchQuery.trim() !== search || options.isFetching,
  };
}

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

const RESOURCE_OPTION_LIMIT = 50;
