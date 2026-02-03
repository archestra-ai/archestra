"use client";

import { BrowserPreviewContent } from "@/components/chat/browser-preview-content";

interface BrowserPreviewClientProps {
  /** Initial conversationId from URL, but popup will follow active conversation */
  initialConversationId: string;
}

export function BrowserPreviewClient({
  initialConversationId,
}: BrowserPreviewClientProps) {
  // The popup follows the active conversation via localStorage, not the URL
  // The initialConversationId is used as fallback if no active conversation is set
  return (
    <div className="h-screen w-full flex flex-col">
      <BrowserPreviewContent
        conversationId={initialConversationId}
        isActive={true}
        isPopup={true}
        className="flex-1"
      />
    </div>
  );
}
