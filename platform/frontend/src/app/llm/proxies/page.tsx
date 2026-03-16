import {
  archestraApiSdk,
  type archestraApiTypes,
  type ErrorExtended,
} from "@shared";

import { ServerErrorFallback } from "@/components/error-fallback";
import { getServerApiHeaders } from "@/lib/server-utils";
import {
  DEFAULT_SORT_BY,
  DEFAULT_SORT_DIRECTION,
  DEFAULT_TABLE_LIMIT,
  handleApiError,
} from "@/lib/utils";
import LlmProxiesPage from "./page.client";

export const dynamic = "force-dynamic";

export default async function LlmProxiesPageServer() {
  let initialData: {
    agents: archestraApiTypes.GetAgentsResponses["200"] | null;
    teams: archestraApiTypes.GetTeamsResponses["200"]["data"];
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
          limit: DEFAULT_TABLE_LIMIT,
          offset: 0,
          sortBy: DEFAULT_SORT_BY,
          sortDirection: DEFAULT_SORT_DIRECTION,
          agentTypes: ["llm_proxy", "profile"],
        },
      }),
      archestraApiSdk.getTeams({
        headers,
        query: { limit: 100, offset: 0 },
      }),
    ]);
    if (agentsResponse.error) {
      handleApiError(agentsResponse.error);
    }
    if (teamsResponse.error) {
      handleApiError(teamsResponse.error);
    }
    initialData = {
      agents: agentsResponse.data || null,
      teams: teamsResponse.data?.data ?? [],
    };
  } catch (error) {
    return <ServerErrorFallback error={error as ErrorExtended} />;
  }
  return <LlmProxiesPage initialData={initialData} />;
}
