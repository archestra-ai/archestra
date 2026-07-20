"use client";

import { BrowserPreviewContent } from "@/components/chat/browser-preview-content";

interface BrowserPreviewClientProps {
  /** Initial conversationId from URL, but popup will follow active conversation */
  initialConversationId: string;
}

export function BrowserPreviewClient({
  initialConversationId,
}: BrowserPreviewClientProps) {
  return (
    <div className="h-app-viewport w-full flex flex-col">
      <BrowserPreviewContent
        conversationId={initialConversationId}
        isActive={true}
        isPopup={true}
        className="flex-1"
      />
    </div>
  );
}
