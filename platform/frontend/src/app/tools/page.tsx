import { archestraApiSdk, type ErrorExtended } from "@shared";

import { ServerErrorFallback } from "@/components/error-fallback";
import { getServerApiHeaders } from "@/lib/server-utils";
import { ToolsClient } from "./page.client";

export const dynamic = "force-dynamic";

export default async function ToolsPage() {
  try {
    const headers = await getServerApiHeaders();

    const agentToolsResponse = await archestraApiSdk.getAllAgentTools({
      headers,
      query: {
        limit: 50,
        offset: 0,
      },
    });

    const agentsResponse = await archestraApiSdk.getAllAgents({ headers });
    const internalCatalogResponse = await archestraApiSdk.getInternalMcpCatalog(
      { headers },
    );

    const initialAgentTools = agentToolsResponse.data ?? {
      data: [],
      pagination: {
        currentPage: 1,
        limit: 50,
        total: 0,
        totalPages: 0,
        hasNext: false,
        hasPrev: false,
      },
    };

    return (
      <ToolsClient
        initialAgentTools={initialAgentTools}
        initialAgents={agentsResponse.data ?? []}
        initialInternalMcpCatalog={internalCatalogResponse.data ?? []}
      />
    );
  } catch (error) {
    console.error(error);
    return <ServerErrorFallback error={error as ErrorExtended} />;
  }
}
