import {
  archestraApiSdk,
  type archestraApiTypes,
  type ErrorExtended,
} from "@shared";

import { ServerErrorFallback } from "@/components/error-fallback";
import { getServerApiHeaders } from "@/lib/server-utils";
import { DEFAULT_TABLE_LIMIT } from "@/lib/utils";
import LlmProxyLogsPage from "./page.client";

export const dynamic = "force-dynamic";

export default async function LlmProxyLogsPageServer() {
  let initialData: {
    interactions: archestraApiTypes.GetInteractionsResponses["200"];
    agents: archestraApiTypes.GetAgentsResponses["200"];
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
    initialData = {
      interactions: (
        await archestraApiSdk.getInteractions({
          headers,
          query: {
            limit: DEFAULT_TABLE_LIMIT,
            offset: 0,
            sortBy: "createdAt",
            sortDirection: "desc",
          },
        })
      ).data || {
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
  return <LlmProxyLogsPage initialData={initialData} />;
}
