import { ChatPageContent } from "../page.client";
import { ConversationParts } from "./conversation-parts";

export default async function ConversationPage({
  params,
}: {
  params: Promise<{ conversationId: string }>;
}) {
  const { conversationId } = await params;

  return (
    <>
      <ConversationParts />
      <ChatPageContent
        key={conversationId}
        routeConversationId={conversationId}
      />
    </>
  );
}
