import { archestraApiSdk, type ErrorExtended } from "@shared";
import { ServerErrorFallback } from "@/components/error-fallback";
import { getServerApiHeaders } from "@/lib/server-utils";
import { DEFAULT_TABLE_LIMIT } from "@/lib/utils";
import ProfilesPage from "./page.client";

export const dynamic = "force-dynamic";

export default async function ProfilesPageServer() {
  try {
    const headers = await getServerApiHeaders();

    const agentsResponse = await archestraApiSdk.getAgents({
      headers,
      query: {
        limit: 20,
        offset: 0,
        sortBy: "createdAt",
        sortDirection: "desc",
      },
    });

    const teamsResponse = await archestraApiSdk.getTeams({ headers });
    const labelKeysResponse = await archestraApiSdk.getLabelKeys({ headers });

    const initialAgents = agentsResponse.data ?? {
      data: [],
      pagination: {
        currentPage: 1,
        limit: DEFAULT_TABLE_LIMIT,
        total: 0,
        totalPages: 0,
        hasNext: false,
        hasPrev: false,
      },
    };

    return (
      <ProfilesPage
        initialData={initialAgents}
        initialTeams={teamsResponse.data ?? []}
        initialLabelKeys={labelKeysResponse.data ?? []}
      />
    );
  } catch (error) {
    console.error(error);
    return <ServerErrorFallback error={error as ErrorExtended} />;
  }
}
