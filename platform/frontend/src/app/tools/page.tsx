import {
  archestraApiSdk,
  type archestraApiTypes,
  type ErrorExtended,
} from "@shared";

import { ServerErrorFallback } from "@/components/error-fallback";
import { getServerApiHeaders } from "@/lib/server-utils";
import { ToolsClient } from "./page.client";

export const dynamic = "force-dynamic";

const DEFAULT_PAGE_SIZE = 50;

export type ToolsInitialData = {
  agentTools: archestraApiTypes.GetAllAgentToolsResponses["200"];
  agents: archestraApiTypes.GetAllAgentsResponses["200"];
  mcpServers: archestraApiTypes.GetMcpServersResponses["200"];
  internalMcpCatalog: archestraApiTypes.GetInternalMcpCatalogResponses["200"];
};

export default async function ToolsPage() {
  let initialData: ToolsInitialData = {
    agentTools: {
      data: [],
      pagination: {
        currentPage: 1,
        limit: DEFAULT_PAGE_SIZE,
        total: 0,
        totalPages: 0,
        hasNext: false,
        hasPrev: false,
      },
    },
    agents: [],
    mcpServers: [],
    internalMcpCatalog: [],
  };
  try {
    const headers = await getServerApiHeaders();
    initialData = {
      agentTools: (
        await archestraApiSdk.getAllAgentTools({
          headers,
          query: {
            limit: DEFAULT_PAGE_SIZE,
            offset: 0,
            sortBy: "createdAt",
            sortDirection: "desc",
            excludeArchestraTools: true,
          },
        })
      ).data || initialData.agentTools,
      agents: (await archestraApiSdk.getAllAgents({ headers })).data || [],
      mcpServers:
        (await archestraApiSdk.getMcpServers({ headers })).data || [],
      internalMcpCatalog:
        (await archestraApiSdk.getInternalMcpCatalog({ headers })).data || [],
    };
  } catch (error) {
    console.error(error);
    return <ServerErrorFallback error={error as ErrorExtended} />;
  }
  return <ToolsClient initialData={initialData} />;
}
