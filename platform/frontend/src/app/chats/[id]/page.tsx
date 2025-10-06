import { type GetChatResponses, getChat } from "@shared/api-client";
import { ChatPage } from "./page.client";

export default async function ChatPageServer({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const id = (await params).id;
  let initialData: GetChatResponses["200"] | undefined;
  try {
    initialData = (await getChat({ path: { chatId: id } })).data;
  } catch (error) {
    console.error(error);
  }

  return <ChatPage initialData={initialData} id={id} />;
}
