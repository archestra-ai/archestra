"use client";

import { BrowserPreviewContent } from "@/components/chat/browser-preview-content";

interface BrowserPreviewClientProps {
  conversationId: string;
}

export function BrowserPreviewClient({
  conversationId,
}: BrowserPreviewClientProps) {
  return (
    <div className="h-screen w-full flex flex-col">
      <BrowserPreviewContent
        conversationId={conversationId}
        isActive={true}
        className="flex-1"
      />
    </div>
  );
}
