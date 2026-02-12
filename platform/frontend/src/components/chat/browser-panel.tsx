"use client";

import {
  BROWSER_PREVIEW_HEADER_HEIGHT,
  DEFAULT_BROWSER_PREVIEW_VIEWPORT_HEIGHT,
  DEFAULT_BROWSER_PREVIEW_VIEWPORT_WIDTH,
} from "@shared";
import { ExternalLink, X } from "lucide-react";
import { useCallback } from "react";
import { BrowserPreviewContent } from "@/components/chat/browser-preview-content";
import { Button } from "@/components/ui/button";

interface BrowserPanelProps {
  isOpen: boolean;
  onClose: () => void;
  conversationId: string | undefined;
  /** Fallback agentId for pre-conversation case */
  agentId?: string;
  /** Called when user enters a URL without a conversation - should create conversation and navigate */
  onCreateConversationWithUrl?: (url: string) => void;
  /** Whether conversation creation is in progress */
  isCreatingConversation?: boolean;
  /** URL to navigate to once connected (after conversation creation) */
  initialNavigateUrl?: string;
  /** Called after initial navigation is triggered */
  onInitialNavigateComplete?: () => void;
}

export function BrowserPanel({
  isOpen,
  onClose,
  conversationId,
  agentId,
  onCreateConversationWithUrl,
  isCreatingConversation = false,
  initialNavigateUrl,
  onInitialNavigateComplete,
}: BrowserPanelProps) {
  const handleOpenInNewWindow = useCallback(() => {
    if (!conversationId) return;

    // Calculate window dimensions
    const windowWidth = DEFAULT_BROWSER_PREVIEW_VIEWPORT_WIDTH;
    const windowHeight =
      DEFAULT_BROWSER_PREVIEW_VIEWPORT_HEIGHT + BROWSER_PREVIEW_HEADER_HEIGHT;

    // Center the window on screen
    const left = Math.round((screen.width - windowWidth) / 2);
    const top = Math.round((screen.height - windowHeight) / 2);

    window.open(
      `/chat/browser-preview/${conversationId}`,
      "_blank",
      `width=${windowWidth},height=${windowHeight},left=${left},top=${top},resizable=yes,scrollbars=no`,
    );
  }, [conversationId]);

  if (!isOpen) return null;

  return (
    <BrowserPreviewContent
      conversationId={conversationId}
      isActive={isOpen}
      agentId={agentId}
      onCreateConversationWithUrl={onCreateConversationWithUrl}
      isCreatingConversation={isCreatingConversation}
      initialNavigateUrl={initialNavigateUrl}
      onInitialNavigateComplete={onInitialNavigateComplete}
      className="border-t"
      headerActions={
        <>
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            onClick={handleOpenInNewWindow}
            title="Open in new window"
          >
            <ExternalLink className="h-3 w-3" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            onClick={onClose}
            title="Close"
          >
            <X className="h-3 w-3" />
          </Button>
        </>
      }
    />
  );
}
