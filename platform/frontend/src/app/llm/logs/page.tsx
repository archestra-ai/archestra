import {
  archestraApiSdk,
  type archestraApiTypes,
  type ErrorExtended,
} from "@archestra/shared";

import { ServerErrorFallback } from "@/components/error-fallback";
import { handleApiError } from "@/lib/utils";
import { getServerApiHeaders } from "@/lib/utils/server";
import LlmProxyLogsPage from "./page.client";

export const dynamic = "force-dynamic";

export default async function LlmProxyLogsPageServer() {
  // Only the agent list is prefetched. The table is session-based
  // (useInteractionSessions in page.client.tsx) and has never read an
  // interactions prop, so prefetching /api/interactions here only served to
  // serialize ~10 fully reconstructed LLM request/response bodies into the RSC
  // payload that nothing consumes — tens of MB per render on a busy instance.
  let initialData: {
    agents: archestraApiTypes.GetAllAgentsResponses["200"];
  } = {
    agents: [],
  };
  try {
    const headers = await getServerApiHeaders();
    const agentsResponse = await archestraApiSdk.getAllAgents({
      headers,
      query: { excludeBuiltIn: true, agentTypes: ["agent", "llm_proxy"] },
    });
    if (agentsResponse.error) {
      handleApiError(agentsResponse.error);
    }
    initialData = {
      agents: agentsResponse.data || [],
    };
  } catch (error) {
    return <ServerErrorFallback error={error as ErrorExtended} />;
  }
  return <LlmProxyLogsPage initialData={initialData} />;
}
