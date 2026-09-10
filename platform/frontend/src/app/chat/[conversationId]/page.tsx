import { ChatPageContent } from "../page.client";

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
