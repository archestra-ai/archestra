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
// [ISSUE #3858] Importing the template utility we created in the backend utils
import { getAgentTemplateCatalog } from "../../../../backend/src/agents/utils";
import AgentsPage from "./page.client";

export const dynamic = "force-dynamic";

export default async function AgentsPageServer() {
  let initialData: {
    agents: archestraApiTypes.GetAgentsResponses["200"] | null;
    teams: archestraApiTypes.GetTeamsResponses["200"]["data"];
    templates: any[]; // [ISSUE #3858] Added to store our powerful templates
  } = {
    agents: null,
    teams: [],
    templates: [],
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

    // [ISSUE #3858] Fetching our professional agent templates alongside other data
    const agentTemplates = getAgentTemplateCatalog();

    const [agentsResponse, teamsResponse] = await Promise.all([
      archestraApiSdk.getAgents({
        headers,
        query: {
          limit: DEFAULT_TABLE_LIMIT,
          offset: 0,
          sortBy: DEFAULT_SORT_BY,
          sortDirection: DEFAULT_SORT_DIRECTION,
          agentTypes: ["agent"],
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
      templates: agentTemplates, // [ISSUE #3858] Passing templates to the UI
    };
  } catch (error) {
    return <ServerErrorFallback error={error as ErrorExtended} />;
  }

  // We are now sending the initialData including our templates to the client page
  return <AgentsPage initialData={initialData} />;
}
