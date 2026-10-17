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
import { serverCanAccessPage } from "@/lib/auth/auth.server";
import { getServerApiHeaders } from "@/lib/utils/server";
import AgentsPage from "./page.client";

export const dynamic = "force-dynamic";

export default async function AgentsPageServer() {
  let initialData: {
    agents: archestraApiTypes.GetAgentCatalogResponses["200"] | null;
    pinnedAgents: archestraApiTypes.GetAgentCatalogResponses["200"] | null;
  } = {
    agents: null,
    pinnedAgents: null,
  };
  try {
    if (!(await serverCanAccessPage("/agents"))) {
      return <ForbiddenPage />;
    }

    const headers = await getServerApiHeaders();
    const [agentsResult, pinnedAgentsResult] = await Promise.allSettled([
      archestraApiSdk.getAgentCatalog({
        headers,
        query: {
          limit: DEFAULT_TABLE_LIMIT,
          offset: 0,
          sortBy: DEFAULT_SORT_BY,
          sortDirection: DEFAULT_SORT_DIRECTION,
          pinned: false,
          access: DEFAULT_RESOURCE_ACCESS_RELATIONS,
          includeTools: false,
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
          access: DEFAULT_RESOURCE_ACCESS_RELATIONS,
          includeBuiltIn: true,
          includeTools: false,
        },
      }),
    ]);
    const agentsResponse =
      agentsResult.status === "fulfilled" ? agentsResult.value : undefined;
    const pinnedAgentsResponse =
      pinnedAgentsResult.status === "fulfilled"
        ? pinnedAgentsResult.value
        : undefined;
    initialData = {
      agents: agentsResponse?.data ?? null,
      pinnedAgents: pinnedAgentsResponse?.data ?? null,
    };
  } catch (error) {
    return <ServerErrorFallback error={error as ErrorExtended} />;
  }
  return <AgentsPage initialData={initialData} />;
}
