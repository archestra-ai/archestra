import {
  archestraApiSdk,
  type archestraApiTypes,
  type ErrorExtended,
} from "@shared";

import { ServerErrorFallback } from "@/components/error-fallback";
import { getServerApiHeaders } from "@/lib/server-utils";
import ProfilesPage from "./page.client";

export const dynamic = "force-dynamic";

const DEFAULT_PAGE_SIZE = 20;

export default async function ProfilesPageServer() {
  let initialData: {
    agents: archestraApiTypes.GetAgentsResponses["200"] | null;
    teams: archestraApiTypes.GetTeamsResponses["200"];
  } = {
    agents: null,
    teams: [],
  };
  try {
    const headers = await getServerApiHeaders();
    initialData = {
      agents:
        (
          await archestraApiSdk.getAgents({
            headers,
            query: {
              limit: DEFAULT_PAGE_SIZE,
              offset: 0,
              sortBy: "createdAt",
              sortDirection: "desc",
            },
          })
        ).data || null,
      teams: (await archestraApiSdk.getTeams({ headers })).data || [],
    };
  } catch (error) {
    console.error(error);
    return <ServerErrorFallback error={error as ErrorExtended} />;
  }
  return <ProfilesPage initialData={initialData} />;
}
