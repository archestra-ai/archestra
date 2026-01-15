import {
  archestraApiSdk,
  type archestraApiTypes,
  type ErrorExtended,
} from "@shared";

import { ServerErrorFallback } from "@/components/error-fallback";
import {
  transformToolInvocationPolicies,
  transformToolResultPolicies,
} from "@/lib/policy.utils";
import { getServerApiHeaders } from "@/lib/server-utils";
import {
  DEFAULT_SORT_BY,
  DEFAULT_SORT_DIRECTION,
  DEFAULT_TOOLS_PAGE_SIZE,
} from "@/lib/utils";
import { ToolsClient } from "./page.client";

export const dynamic = "force-dynamic";

export type ToolsInitialData = {
  toolsWithAssignments: archestraApiTypes.GetToolsWithAssignmentsResponses["200"];
  internalMcpCatalog: archestraApiTypes.GetInternalMcpCatalogResponses["200"];
  toolInvocationPolicies: ReturnType<typeof transformToolInvocationPolicies>;
  toolResultPolicies: ReturnType<typeof transformToolResultPolicies>;
};

export default async function ToolsPage() {
  let initialData: ToolsInitialData = {
    toolsWithAssignments: {
      data: [],
      pagination: {
        currentPage: 1,
        limit: DEFAULT_TOOLS_PAGE_SIZE,
        total: 0,
        totalPages: 0,
        hasNext: false,
        hasPrev: false,
      },
    },
    internalMcpCatalog: [],
    toolInvocationPolicies: { all: [], byProfileToolId: {} },
    toolResultPolicies: { all: [], byProfileToolId: {} },
  };
  try {
    const headers = await getServerApiHeaders();
    initialData = {
      toolsWithAssignments:
        (
          await archestraApiSdk.getToolsWithAssignments({
            headers,
            query: {
              limit: DEFAULT_TOOLS_PAGE_SIZE,
              offset: 0,
              sortBy: DEFAULT_SORT_BY,
              sortDirection: DEFAULT_SORT_DIRECTION,
            },
          })
        ).data || initialData.toolsWithAssignments,
      internalMcpCatalog:
        (await archestraApiSdk.getInternalMcpCatalog({ headers })).data || [],
      toolInvocationPolicies: transformToolInvocationPolicies(
        (await archestraApiSdk.getToolInvocationPolicies({ headers })).data ||
          [],
      ),
      toolResultPolicies: transformToolResultPolicies(
        (await archestraApiSdk.getTrustedDataPolicies({ headers })).data || [],
      ),
    };
  } catch (error) {
    console.error(error);
    return <ServerErrorFallback error={error as ErrorExtended} />;
  }
  return <ToolsClient initialData={initialData} />;
}
