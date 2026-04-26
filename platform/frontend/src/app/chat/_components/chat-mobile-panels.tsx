"use client";

import { BrowserPanel } from "@/components/chat/browser-panel";
import { ConversationArtifactPanel } from "@/components/chat/conversation-artifact";
import { cn } from "@/lib/utils";

export function ChatMobilePanels({
  agentId,
  artifact,
  conversationId,
  initialNavigateUrl,
  isArtifactOpen,
  isBrowserOpen,
  isCreatingConversation,
  onArtifactToggle,
  onBrowserClose,
  onCreateConversationWithUrl,
  onInitialNavigateComplete,
}: {
  agentId: string | undefined;
  artifact: string | null | undefined;
  conversationId: string | undefined;
  initialNavigateUrl: string | undefined;
  isArtifactOpen: boolean;
  isBrowserOpen: boolean;
  isCreatingConversation: boolean;
  onArtifactToggle: () => void;
  onBrowserClose: () => void;
  onCreateConversationWithUrl: (url: string) => void;
  onInitialNavigateComplete: () => void;
}) {
  if (!isArtifactOpen && !isBrowserOpen) {
    return null;
  }

  return (
    <div className="flex-1 flex flex-col min-h-0 overflow-hidden md:hidden">
      {isArtifactOpen && (
        <div
          className={cn(
            "min-h-0 overflow-auto",
            isBrowserOpen ? "h-1/2 border-b" : "flex-1",
          )}
        >
          <ConversationArtifactPanel
            artifact={artifact}
            isOpen={isArtifactOpen}
            onToggle={onArtifactToggle}
            embedded
          />
        </div>
      )}
      {isBrowserOpen && (
        <div
          className={cn(
            "min-h-0 overflow-auto",
            isArtifactOpen ? "h-1/2" : "flex-1",
          )}
        >
          <BrowserPanel
            isOpen={true}
            onClose={onBrowserClose}
            conversationId={conversationId}
            agentId={agentId}
            onCreateConversationWithUrl={onCreateConversationWithUrl}
            isCreatingConversation={isCreatingConversation}
            initialNavigateUrl={initialNavigateUrl}
            onInitialNavigateComplete={onInitialNavigateComplete}
          />
        </div>
      )}
    </div>
  );
}
