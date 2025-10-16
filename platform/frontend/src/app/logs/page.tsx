import {
  type GetAgentsResponses,
  type GetInteractionsResponses,
  getAgents,
  getInteractions,
} from "@/lib/clients/api";
import { getServerApiHeaders } from "@/lib/server-utils";
import { DEFAULT_TABLE_LIMIT } from "@/lib/utils";
import LogsPage from "./page.client";

export const dynamic = "force-dynamic";

export default async function LogsPageServer() {
  let initialData: {
    interactions: GetInteractionsResponses["200"];
    agents: GetAgentsResponses["200"];
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
        await getInteractions({
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
      agents: (await getAgents({ headers })).data || [],
    };
  } catch (error) {
    console.error(error);
  }
  return <LogsPage initialData={initialData} />;
}
