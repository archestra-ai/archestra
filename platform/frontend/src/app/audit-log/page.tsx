import {
  archestraApiSdk,
  type archestraApiTypes,
  type ErrorExtended,
} from "@shared";
import { ServerErrorFallback } from "@/components/error-fallback";
import { handleApiError } from "@/lib/utils";
import { getServerApiHeaders } from "@/lib/utils/server";
import { AUDIT_LOG_SOURCE_LIMIT } from "./_parts/audit-log.types";
import AuditLogPage from "./page.client";

export const dynamic = "force-dynamic";

function createEmptyPaginatedResponse<T>(limit: number) {
  return {
    data: [] as T[],
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

export default async function AuditLogPageServer() {
  let initialData: {
    interactions: archestraApiTypes.GetInteractionsResponses["200"];
    mcpToolCalls: archestraApiTypes.GetMcpToolCallsResponses["200"];
  } = {
    interactions: createEmptyPaginatedResponse<
      archestraApiTypes.GetInteractionsResponses["200"]["data"][number]
    >(AUDIT_LOG_SOURCE_LIMIT),
    mcpToolCalls: createEmptyPaginatedResponse<
      archestraApiTypes.GetMcpToolCallsResponses["200"]["data"][number]
    >(AUDIT_LOG_SOURCE_LIMIT),
  };

  try {
    const headers = await getServerApiHeaders();
    const [interactionsResponse, mcpToolCallsResponse] = await Promise.all([
      archestraApiSdk.getInteractions({
        headers,
        query: {
          limit: AUDIT_LOG_SOURCE_LIMIT,
          offset: 0,
          sortBy: "createdAt",
          sortDirection: "desc",
        },
      }),
      archestraApiSdk.getMcpToolCalls({
        headers,
        query: {
          limit: AUDIT_LOG_SOURCE_LIMIT,
          offset: 0,
          sortBy: "createdAt",
          sortDirection: "desc",
        },
      }),
    ]);

    if (interactionsResponse.error) {
      handleApiError(interactionsResponse.error);
    }
    if (mcpToolCallsResponse.error) {
      handleApiError(mcpToolCallsResponse.error);
    }

    initialData = {
      interactions:
        interactionsResponse.data ??
        createEmptyPaginatedResponse<
          archestraApiTypes.GetInteractionsResponses["200"]["data"][number]
        >(AUDIT_LOG_SOURCE_LIMIT),
      mcpToolCalls:
        mcpToolCallsResponse.data ??
        createEmptyPaginatedResponse<
          archestraApiTypes.GetMcpToolCallsResponses["200"]["data"][number]
        >(AUDIT_LOG_SOURCE_LIMIT),
    };
  } catch (error) {
    return <ServerErrorFallback error={error as ErrorExtended} />;
  }

  return <AuditLogPage initialData={initialData} />;
}
