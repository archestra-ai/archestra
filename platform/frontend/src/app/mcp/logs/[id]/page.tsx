import {
  archestraApiSdk,
  type archestraApiTypes,
  type ErrorExtended,
} from "@archestra/shared";

import { ServerErrorFallback } from "@/components/error-fallback";
import { handleApiError } from "@/lib/utils";
import { getServerApiHeaders } from "@/lib/utils/server";
import { McpToolCallDetailPage } from "./page.client";

export default async function McpToolCallDetailPageServer({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const id = (await params).id;
  let initialData: {
    mcpToolCall: archestraApiTypes.GetMcpToolCallResponses["200"] | undefined;
  } = {
    mcpToolCall: undefined,
  };
  try {
    const headers = await getServerApiHeaders();
    const mcpToolCallResponse = await archestraApiSdk.getMcpToolCall({
      headers,
      path: { mcpToolCallId: id },
    });
    if (mcpToolCallResponse.error) {
      handleApiError(mcpToolCallResponse.error);
    }
    initialData = {
      mcpToolCall: mcpToolCallResponse.data,
    };
  } catch (error) {
    return <ServerErrorFallback error={error as ErrorExtended} />;
  }

  return <McpToolCallDetailPage initialData={initialData} id={id} />;
}
