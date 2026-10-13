import {
  archestraApiSdk,
  type archestraApiTypes,
  DEFAULT_RESOURCE_ACCESS_RELATIONS,
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
import McpGatewaysPage from "./page.client";

export const dynamic = "force-dynamic";

export default async function McpGatewaysPageServer() {
  let initialData: {
    agents: archestraApiTypes.GetAgentsResponses["200"] | null;
    pinnedAgents: archestraApiTypes.GetAgentsResponses["200"] | null;
    teams: archestraApiTypes.GetTeamsResponses["200"]["data"];
  } = {
    agents: null,
    pinnedAgents: null,
    teams: [],
  };
  try {
    if (!(await serverCanAccessPage("/mcp/gateways"))) {
      return <ForbiddenPage />;
    }

    const headers = await getServerApiHeaders();
    const canReadTeams = await serverHasPermissions({ team: ["read"] });
    const canReadAgents = await serverHasPermissions({ agent: ["read"] });
    const gatewayAgentTypes: Array<"mcp_gateway" | "profile"> = canReadAgents
      ? ["mcp_gateway", "profile"]
      : ["mcp_gateway"];
    const emptyTeamsResponse = {
      data: { data: [] },
      error: undefined,
    };
    const [agentsResult, pinnedAgentsResult, teamsResult] =
      await Promise.allSettled([
        archestraApiSdk.getAgents({
          headers,
          query: {
            limit: DEFAULT_TABLE_LIMIT,
            offset: 0,
            sortBy: DEFAULT_SORT_BY,
            sortDirection: DEFAULT_SORT_DIRECTION,
            agentTypes: gatewayAgentTypes,
            pinned: false,
            access: DEFAULT_RESOURCE_ACCESS_RELATIONS,
          },
        }),
        archestraApiSdk.getAgents({
          headers,
          query: {
            limit: 100,
            offset: 0,
            sortBy: DEFAULT_SORT_BY,
            sortDirection: DEFAULT_SORT_DIRECTION,
            agentTypes: gatewayAgentTypes,
            pinned: true,
            access: DEFAULT_RESOURCE_ACCESS_RELATIONS,
          },
        }),
        canReadTeams
          ? archestraApiSdk.getTeams({
              headers,
              query: { limit: 100, offset: 0 },
            })
          : Promise.resolve(emptyTeamsResponse),
      ]);
    // A failed prefetch must leave the client query able to retry, including
    // the deleted view where the active pinned section is not needed.
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
  return <McpGatewaysPage initialData={initialData} />;
}
