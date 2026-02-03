import { BrowserPreviewClient } from "./page.client";

interface PageProps {
  params: Promise<{
    conversationId: string;
  }>;
}

export default async function BrowserPreviewPage({ params }: PageProps) {
  const { conversationId } = await params;
  // Pass initial conversationId - the popup will follow active conversation via localStorage
  return <BrowserPreviewClient initialConversationId={conversationId} />;
}
