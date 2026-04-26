import { ChatPageContent } from "../_components/chat-page-content";

export default async function ConversationPage({
  params,
}: {
  params: Promise<{ conversationId: string }>;
}) {
  const { conversationId } = await params;

  return (
    <ChatPageContent
      key={conversationId}
      routeConversationId={conversationId}
    />
  );
}
