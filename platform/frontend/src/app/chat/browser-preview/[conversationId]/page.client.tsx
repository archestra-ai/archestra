"use client";

import { BrowserPreviewContent } from "@/components/chat/browser-preview-content";
import { useChatSession } from "@/contexts/global-chat-context";

interface BrowserPreviewClientProps {
  conversationId: string;
}

export function BrowserPreviewClient({
  conversationId,
}: BrowserPreviewClientProps) {
  // Use chat session for syncing navigation messages (optional but improves UX)
  const chatSession = useChatSession(conversationId);
  const chatMessages = chatSession?.messages ?? [];
  const setChatMessages = chatSession?.setMessages;

  return (
    <div className="h-screen w-full flex flex-col">
      <BrowserPreviewContent
        conversationId={conversationId}
        isActive={true}
        chatMessages={chatMessages}
        setChatMessages={setChatMessages}
        className="flex-1"
      />
    </div>
  );
}
