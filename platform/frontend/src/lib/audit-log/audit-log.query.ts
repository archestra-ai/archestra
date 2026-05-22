"use client";

import { useQuery } from "@tanstack/react-query";
import { DEFAULT_TABLE_LIMIT } from "@/consts";
import { handleApiError } from "@/lib/utils";

export type AuditLogEntry = {
  id: string;
  organizationId: string;
  userId: string | null;
  action: string;
  resource: string;
  resourceId: string | null;
  metadata: {
    ip: string | null;
    userAgent: string | null;
    diff: Record<string, unknown> | null;
  };
  createdAt: string;
  userName: string | null;
  userEmail: string | null;
};

type PaginationMeta = {
  currentPage: number;
  limit: number;
  total: number;
  totalPages: number;
  hasNext: boolean;
  hasPrev: boolean;
};

type AuditLogResponse = {
  data: AuditLogEntry[];
  pagination: PaginationMeta;
};

export function useAuditLogs({
  action,
  resource,
  userId,
  startDate,
  endDate,
  search,
  limit = DEFAULT_TABLE_LIMIT,
  offset = 0,
  sortBy,
  sortDirection = "desc",
  initialData,
}: {
  action?: string;
  resource?: string;
  userId?: string;
  startDate?: string;
  endDate?: string;
  search?: string;
  limit?: number;
  offset?: number;
  sortBy?: "createdAt" | "action" | "resource";
  sortDirection?: "asc" | "desc";
  initialData?: AuditLogResponse;
} = {}) {
  return useQuery({
    queryKey: [
      "auditLogs",
      action,
      resource,
      userId,
      startDate,
      endDate,
      search,
      limit,
      offset,
      sortBy,
      sortDirection,
    ],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (action) params.set("action", action);
      if (resource) params.set("resource", resource);
      if (userId) params.set("userId", userId);
      if (startDate) params.set("startDate", startDate);
      if (endDate) params.set("endDate", endDate);
      if (search) params.set("search", search);
      params.set("limit", String(limit));
      params.set("offset", String(offset));
      if (sortBy) params.set("sortBy", sortBy);
      params.set("sortDirection", sortDirection);

      const response = await fetch(`/api/audit-logs?${params.toString()}`);
      if (!response.ok) {
        const error = await response.json().catch(() => null);
        handleApiError(error || { message: response.statusText });
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
      return response.json() as Promise<AuditLogResponse>;
    },
    initialData,
  });
}

export function useAuditLogEntry(id: string) {
  return useQuery({
    queryKey: ["auditLog", id],
    queryFn: async () => {
      const response = await fetch(`/api/audit-logs/${id}`);
      if (!response.ok) {
        const error = await response.json().catch(() => null);
        handleApiError(error || { message: response.statusText });
        return null;
      }
      return response.json() as Promise<AuditLogEntry>;
    },
    enabled: !!id,
  });
}
