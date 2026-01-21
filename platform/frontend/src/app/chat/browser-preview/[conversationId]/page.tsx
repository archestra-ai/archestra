import { BrowserPreviewClient } from "./page.client";

interface PageProps {
  params: Promise<{
    conversationId: string;
  }>;
}

export default async function BrowserPreviewPage({ params }: PageProps) {
  const { conversationId } = await params;
  return <BrowserPreviewClient conversationId={conversationId} />;
}
