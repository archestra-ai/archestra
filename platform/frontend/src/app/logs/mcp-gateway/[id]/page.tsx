import {
  archestraApiSdk,
  type archestraApiTypes,
  type ErrorExtended,
} from "@shared";

import { ServerErrorFallback } from "@/components/error-fallback";
import { getServerApiHeaders } from "@/lib/server-utils";
import { handleApiError } from "@/lib/utils";
import { McpToolCallDetailPage } from "./page.client";

export default async function McpToolCallDetailPageServer({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const id = (await params).id;
  let initialData: {
    mcpToolCall: archestraApiTypes.GetMcpToolCallResponses["200"] | undefined;
    agents: archestraApiTypes.GetAllAgentsResponses["200"];
  } = {
    mcpToolCall: undefined,
    agents: [],
  };
  try {
    const headers = await getServerApiHeaders();
    const [mcpToolCallResponse, agentsResponse] = await Promise.all([
      archestraApiSdk.getMcpToolCall({
        headers,
        path: { mcpToolCallId: id },
      }),
      archestraApiSdk.getAllAgents({ headers }),
    ]);
    if (mcpToolCallResponse.error) {
      handleApiError(mcpToolCallResponse.error);
    }
    if (agentsResponse.error) {
      handleApiError(agentsResponse.error);
    }
    initialData = {
      mcpToolCall: mcpToolCallResponse.data,
      agents: agentsResponse.data || [],
    };
  } catch (error) {
    return <ServerErrorFallback error={error as ErrorExtended} />;
  }

  return <McpToolCallDetailPage initialData={initialData} id={id} />;
}
