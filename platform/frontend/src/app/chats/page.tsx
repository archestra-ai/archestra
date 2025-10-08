import {
  type GetAgentsResponses,
  type GetChatsResponses,
  getAgents,
  getChats,
} from "@shared/api-client";
import ChatsPage from "./page.client";

export const dynamic = "force-dynamic";

export default async function ChatsPageServer() {
  let initialData:
    | {
        chats: GetChatsResponses["200"];
        agents: GetAgentsResponses["200"];
      }
    | undefined;
  try {
    initialData = {
      chats: (await getChats()).data ?? [],
      agents: (await getAgents()).data ?? [],
    };
  } catch (error) {
    console.error(error);
  }
  return <ChatsPage initialData={initialData} />;
}
