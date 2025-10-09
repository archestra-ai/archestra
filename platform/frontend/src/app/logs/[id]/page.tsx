import {
  type GetAgentsResponses,
  type GetInteractionResponse,
  getAgents,
  getInteraction,
} from "@shared/api-client";
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
    initialData = {
      interaction: (await getInteraction({ path: { interactionId: id } })).data,
      agents: (await getAgents()).data || [],
    };
  } catch (error) {
    console.error(error);
  }

  return <ChatPage initialData={initialData} id={id} />;
}
