import {
  archestraApiSdk,
  type archestraApiTypes,
  type ErrorExtended,
} from "@shared";

import { ServerErrorFallback } from "@/components/error-fallback";
import { getServerApiHeaders } from "@/lib/server-utils";
import { DEFAULT_TABLE_LIMIT, handleApiError } from "@/lib/utils";
import LlmProxyLogsPage from "./page.client";

export const dynamic = "force-dynamic";

export default async function LlmProxyLogsPageServer() {
  let initialData: {
    interactions: archestraApiTypes.GetInteractionsResponses["200"];
    agents: archestraApiTypes.GetAllAgentsResponses["200"];
  } = {
    interactions: {
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
    const [interactionsResponse, agentsResponse] = await Promise.all([
      archestraApiSdk.getInteractions({
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
    if (interactionsResponse.error) {
      handleApiError(interactionsResponse.error);
    }
    if (agentsResponse.error) {
      handleApiError(agentsResponse.error);
    }
    initialData = {
      interactions: interactionsResponse.data || {
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
  return <LlmProxyLogsPage initialData={initialData} />;
}
