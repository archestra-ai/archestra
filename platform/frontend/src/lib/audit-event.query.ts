"use client";

import { archestraApiSdk, type archestraApiTypes } from "@shared";
import { useQuery } from "@tanstack/react-query";
import { handleApiError } from "@/lib/utils";

const { getAuditEvents } = archestraApiSdk;

type AuditEventsQuery = NonNullable<
  archestraApiTypes.GetAuditEventsData["query"]
>;
export type AuditEventListItem =
  archestraApiTypes.GetAuditEventsResponses["200"]["data"][number];

export function useAuditEvents(
  query: Required<Pick<AuditEventsQuery, "limit" | "offset">> &
    Pick<
      AuditEventsQuery,
      "actorUserId" | "action" | "resourceType" | "from" | "to" | "search"
    >,
  options?: {
    /** Set to e.g. 2000 for “live logs” behavior */
    refetchIntervalMs?: number;
  },
) {
  return useQuery({
    queryKey: ["auditEvents", query],
    queryFn: async () => {
      const response = await getAuditEvents({ query });
      if (response.error) {
        handleApiError(response.error);
        return {
          data: [] as AuditEventListItem[],
          pagination: {
            currentPage: 1,
            limit: query.limit,
            total: 0,
            totalPages: 0,
            hasNext: false,
            hasPrev: false,
          },
        };
      }

      return (
        response.data ?? {
          data: [] as AuditEventListItem[],
          pagination: {
            currentPage: 1,
            limit: query.limit,
            total: 0,
            totalPages: 0,
            hasNext: false,
            hasPrev: false,
          },
        }
      );
    },
    refetchInterval: options?.refetchIntervalMs,
    refetchOnWindowFocus: true,
  });
}
