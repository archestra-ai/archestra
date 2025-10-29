import {
  archestraApiSdk,
  type ErrorExtended,
} from "@shared";

import { ServerErrorFallback } from "@/components/error-fallback";
import { getServerApiHeaders } from "@/lib/server-utils";
import { DEFAULT_TABLE_LIMIT } from "@/lib/utils";
import McpGatewayLogsPage from "./page.client";

export const dynamic = "force-dynamic";

export default async function McpGatewayLogsPageServer() {
  let initialData = {
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

    // TODO: Replace with actual SDK call once codegen is run
    // For now, we'll use placeholder data
    // const mcpToolCallsResponse = await archestraApiSdk.getMcpToolCalls({
    //   headers,
    //   query: {
    //     limit: DEFAULT_TABLE_LIMIT,
    //     offset: 0,
    //     sortBy: "createdAt",
    //     sortDirection: "desc",
    //   },
    // });

    initialData = {
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
      agents: (await archestraApiSdk.getAgents({ headers })).data || [],
    };
  } catch (error) {
    console.error(error);
    return <ServerErrorFallback error={error as ErrorExtended} />;
  }

  return <McpGatewayLogsPage initialData={initialData} />;
}
