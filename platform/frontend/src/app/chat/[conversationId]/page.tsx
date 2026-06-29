import { ChatPageContent } from "../page";

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
