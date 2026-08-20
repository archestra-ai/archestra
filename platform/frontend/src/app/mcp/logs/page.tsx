import {
  archestraApiSdk,
  type archestraApiTypes,
  type ErrorExtended,
} from "@archestra/shared";

import { ServerErrorFallback } from "@/components/error-fallback";
import { DEFAULT_TABLE_LIMIT } from "@/consts";
import { handleApiError } from "@/lib/utils";
import { getServerApiHeaders } from "@/lib/utils/server";
import McpGatewayLogsPage from "./page.client";

export const dynamic = "force-dynamic";

export default async function McpGatewayLogsPageServer() {
  let initialData: {
    mcpToolCalls: archestraApiTypes.GetMcpToolCallsResponses["200"];
  } = {
    mcpToolCalls: {
      data: [],
      pagination: {
        currentPage: 1,
        limit: DEFAULT_TABLE_LIMIT,
        total: 0,
        totalPages: 0,
        hasNext: false,
        hasPrev: false,
      },
    },
  };

  try {
    const headers = await getServerApiHeaders();
    const mcpToolCallsResponse = await archestraApiSdk.getMcpToolCalls({
      headers,
      query: {
        limit: DEFAULT_TABLE_LIMIT,
        offset: 0,
        sortBy: "createdAt",
        sortDirection: "desc",
      },
    });
    if (mcpToolCallsResponse.error) {
      handleApiError(mcpToolCallsResponse.error);
    }
    initialData = {
      mcpToolCalls: mcpToolCallsResponse.data || {
        data: [],
        pagination: {
          currentPage: 1,
          limit: DEFAULT_TABLE_LIMIT,
          total: 0,
          totalPages: 0,
          hasNext: false,
          hasPrev: false,
        },
      },
    };
  } catch (error) {
    return <ServerErrorFallback error={error as ErrorExtended} />;
  }

  return <McpGatewayLogsPage initialData={initialData} />;
}
