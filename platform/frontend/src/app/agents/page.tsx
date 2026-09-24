import {
  archestraApiSdk,
  type archestraApiTypes,
  type ErrorExtended,
} from "@archestra/shared";

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
import { getServerApiHeaders } from "@/lib/utils/server";
import AgentsPage from "./page.client";

export const dynamic = "force-dynamic";

export default async function AgentsPageServer() {
  let initialData: {
    agents: archestraApiTypes.GetAgentCatalogResponses["200"] | null;
    pinnedAgents: archestraApiTypes.GetAgentCatalogResponses["200"] | null;
    teams: archestraApiTypes.GetTeamsResponses["200"]["data"];
  } = {
    agents: null,
    pinnedAgents: null,
    teams: [],
  };
  try {
    if (!(await serverCanAccessPage("/agents"))) {
      return <ForbiddenPage />;
    }

    const headers = await getServerApiHeaders();
    const canReadTeams = await serverHasPermissions({ team: ["read"] });
    const emptyTeamsResponse = {
      data: { data: [] },
      error: undefined,
    };
    const [agentsResult, pinnedAgentsResult, teamsResult] =
      await Promise.allSettled([
        archestraApiSdk.getAgentCatalog({
          headers,
          query: {
            limit: DEFAULT_TABLE_LIMIT,
            offset: 0,
            sortBy: DEFAULT_SORT_BY,
            sortDirection: DEFAULT_SORT_DIRECTION,
            pinned: false,
          },
        }),
        archestraApiSdk.getAgentCatalog({
          headers,
          query: {
            limit: 100,
            offset: 0,
            sortBy: DEFAULT_SORT_BY,
            sortDirection: DEFAULT_SORT_DIRECTION,
            pinned: true,
          },
        }),
        canReadTeams
          ? archestraApiSdk.getTeams({
              headers,
              query: { limit: 100, offset: 0 },
            })
          : Promise.resolve(emptyTeamsResponse),
      ]);
    const agentsResponse =
      agentsResult.status === "fulfilled" ? agentsResult.value : undefined;
    const pinnedAgentsResponse =
      pinnedAgentsResult.status === "fulfilled"
        ? pinnedAgentsResult.value
        : undefined;
    const teamsResponse =
      teamsResult.status === "fulfilled" ? teamsResult.value : undefined;
    initialData = {
      agents: agentsResponse?.data ?? null,
      pinnedAgents: pinnedAgentsResponse?.data ?? null,
      teams: teamsResponse?.data?.data ?? [],
    };
  } catch (error) {
    return <ServerErrorFallback error={error as ErrorExtended} />;
  }
  return <AgentsPage initialData={initialData} />;
}
