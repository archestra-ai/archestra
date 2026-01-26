import { archestraApiSdk, type archestraApiTypes } from "@shared";

import { getServerApiHeaders } from "@/lib/server-utils";
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
    initialData = {
      mcpToolCall: (
        await archestraApiSdk.getMcpToolCall({
          headers,
          path: { mcpToolCallId: id },
        })
      ).data,
      agents: (await archestraApiSdk.getAllAgents({ headers })).data || [],
    };
  } catch (error) {
    console.error(error);
  }

  return <McpToolCallDetailPage initialData={initialData} id={id} />;
}
