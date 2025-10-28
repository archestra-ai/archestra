import { archestraApiSdk, type archestraApiTypes } from "@shared";

import { getServerApiHeaders } from "@/lib/server-utils";
import { ChatPage } from "./page.client";

export default async function ChatPageServer({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const id = (await params).id;
  let initialData: {
    interaction: archestraApiTypes.GetInteractionResponses["200"] | undefined;
    agents: archestraApiTypes.GetAgentsResponses["200"];
  } = {
    interaction: undefined,
    agents: [],
  };
  try {
    const headers = await getServerApiHeaders();
    initialData = {
      interaction: (
        await archestraApiSdk.getInteraction({
          headers,
          path: { interactionId: id },
        })
      ).data,
      agents: (await archestraApiSdk.getAgents({ headers })).data || [],
    };
  } catch (error) {
    console.error(error);
  }

  return <ChatPage initialData={initialData} id={id} />;
}
