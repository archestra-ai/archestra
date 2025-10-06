import { type GetChatsResponses, getChats } from "@shared/api-client";
import ChatsPage from "./page.client";

export const dynamic = "force-dynamic";

export default async function ChatsPageServer() {
  let initialData: GetChatsResponses["200"] | undefined;
  try {
    initialData = (await getChats()).data;
  } catch (error) {
    console.error(error);
  }
  return <ChatsPage initialData={initialData} />;
}
