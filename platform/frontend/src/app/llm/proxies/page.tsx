import {
  archestraApiSdk,
  type archestraApiTypes,
  type ErrorExtended,
} from "@shared";

import { ForbiddenPage } from "@/app/_parts/forbidden-page";
import { ServerErrorFallback } from "@/components/error-fallback";
import {
  DEFAULT_SORT_BY,
  DEFAULT_SORT_DIRECTION,
  DEFAULT_TABLE_LIMIT,
} from "@/consts";
import {
  serverCanAccessPage,
  serverHasPermissions,
} from "@/lib/auth/auth.server";
import { handleApiError } from "@/lib/utils";
import { getServerApiHeaders } from "@/lib/utils/server";
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
    if (!(await serverCanAccessPage("/llm/proxies"))) {
      return <ForbiddenPage />;
    }

    const headers = await getServerApiHeaders();
    const canReadTeams = await serverHasPermissions({ team: ["read"] });
    const emptyTeamsResponse = {
      data: { data: [] },
      error: undefined,
    };
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
      canReadTeams
        ? archestraApiSdk.getTeams({
            headers,
            query: { limit: 100, offset: 0 },
          })
        : Promise.resolve(emptyTeamsResponse),
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
