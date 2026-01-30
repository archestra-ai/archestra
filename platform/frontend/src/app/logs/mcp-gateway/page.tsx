import {
  archestraApiSdk,
  type archestraApiTypes,
  type ErrorExtended,
} from "@shared";

import { ServerErrorFallback } from "@/components/error-fallback";
import { getServerApiHeaders } from "@/lib/server-utils";
import { DEFAULT_TABLE_LIMIT, handleApiError } from "@/lib/utils";
import McpGatewayLogsPage from "./page.client";

export const dynamic = "force-dynamic";

export default async function McpGatewayLogsPageServer() {
  let initialData: {
    mcpToolCalls: archestraApiTypes.GetMcpToolCallsResponses["200"];
    agents: archestraApiTypes.GetAllAgentsResponses["200"];
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
    agents: [],
  };

  try {
    const headers = await getServerApiHeaders();
    const [mcpToolCallsResponse, agentsResponse] = await Promise.all([
      archestraApiSdk.getMcpToolCalls({
        headers,
        query: {
          limit: DEFAULT_TABLE_LIMIT,
          offset: 0,
          sortBy: "createdAt",
          sortDirection: "desc",
        },
      }),
      archestraApiSdk.getAllAgents({ headers }),
    ]);
    if (mcpToolCallsResponse.error) {
      handleApiError(mcpToolCallsResponse.error);
    }
    if (agentsResponse.error) {
      handleApiError(agentsResponse.error);
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
      agents: agentsResponse.data || [],
    };
  } catch (error) {
    return <ServerErrorFallback error={error as ErrorExtended} />;
  }

  return <McpGatewayLogsPage initialData={initialData} />;
}
