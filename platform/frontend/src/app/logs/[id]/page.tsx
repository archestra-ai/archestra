import {
  archestraApiSdk,
  type archestraApiTypes,
  type ErrorExtended,
} from "@shared";

import { ServerErrorFallback } from "@/components/error-fallback";
import { getServerApiHeaders } from "@/lib/server-utils";
import { handleApiError } from "@/lib/utils";
import { ChatPage } from "./page.client";

export default async function ChatPageServer({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const id = (await params).id;
  let initialData: {
    interaction: archestraApiTypes.GetInteractionResponses["200"] | undefined;
    agents: archestraApiTypes.GetAllAgentsResponses["200"];
  } = {
    interaction: undefined,
    agents: [],
  };
  try {
    const headers = await getServerApiHeaders();
    const [interactionResponse, agentsResponse] = await Promise.all([
      archestraApiSdk.getInteraction({
        headers,
        path: { interactionId: id },
      }),
      archestraApiSdk.getAllAgents({ headers }),
    ]);
    if (interactionResponse.error) {
      handleApiError(interactionResponse.error);
    }
    if (agentsResponse.error) {
      handleApiError(agentsResponse.error);
    }
    initialData = {
      interaction: interactionResponse.data,
      agents: agentsResponse.data || [],
    };
  } catch (error) {
    return <ServerErrorFallback error={error as ErrorExtended} />;
  }

  return <ChatPage initialData={initialData} id={id} />;
}
