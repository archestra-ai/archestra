import {
  archestraApiSdk,
  type archestraApiTypes,
  type ErrorExtended,
} from "@shared";

import { ServerErrorFallback } from "@/components/error-fallback";
import { getServerApiHeaders } from "@/lib/server-utils";
import {
  DEFAULT_AGENTS_PAGE_SIZE,
  DEFAULT_SORT_BY,
  DEFAULT_SORT_DIRECTION,
  handleApiError,
} from "@/lib/utils";
import McpGatewaysPage from "./page.client";

export const dynamic = "force-dynamic";

export default async function McpGatewaysPageServer() {
  let initialData: {
    agents: archestraApiTypes.GetAgentsResponses["200"] | null;
    teams: archestraApiTypes.GetTeamsResponses["200"];
  } = {
    agents: null,
    teams: [],
  };
  try {
    const headers = await getServerApiHeaders();
    const [agentsResponse, teamsResponse] = await Promise.all([
      archestraApiSdk.getAgents({
        headers,
        query: {
          limit: DEFAULT_AGENTS_PAGE_SIZE,
          offset: 0,
          sortBy: DEFAULT_SORT_BY,
          sortDirection: DEFAULT_SORT_DIRECTION,
          agentTypes: ["mcp_gateway", "profile"],
        },
      }),
      archestraApiSdk.getTeams({ headers }),
    ]);
    if (agentsResponse.error) {
      handleApiError(agentsResponse.error);
    }
    if (teamsResponse.error) {
      handleApiError(teamsResponse.error);
    }
    initialData = {
      agents: agentsResponse.data || null,
      teams: teamsResponse.data || [],
    };
  } catch (error) {
    return <ServerErrorFallback error={error as ErrorExtended} />;
  }
  return <McpGatewaysPage initialData={initialData} />;
}
