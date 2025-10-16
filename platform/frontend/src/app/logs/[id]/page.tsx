import {
  type GetAgentsResponses,
  type GetInteractionResponse,
  getAgents,
  getInteraction,
} from "@/lib/clients/api";
import { getServerApiHeaders } from "@/lib/server-utils";
import { ChatPage } from "./page.client";

export default async function ChatPageServer({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const id = (await params).id;
  let initialData: {
    interaction: GetInteractionResponse | undefined;
    agents: GetAgentsResponses["200"];
  } = {
    interaction: undefined,
    agents: [],
  };
  try {
    const headers = await getServerApiHeaders();
    initialData = {
      interaction: (
        await getInteraction({ headers, path: { interactionId: id } })
      ).data,
      agents: (await getAgents({ headers })).data || [],
    };
  } catch (error) {
    console.error(error);
  }

  return <ChatPage initialData={initialData} id={id} />;
}
