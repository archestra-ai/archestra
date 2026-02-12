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
  /** When true, shows "Installing browser" message instead of normal content */
  isInstallingBrowser?: boolean;
  /** Whether Playwright MCP tools are available */
  hasPlaywrightMcpTools?: boolean;
  /** Whether Playwright MCP server is installed (but tools may not be assigned) */
  isPlaywrightInstalledByCurrentUser?: boolean;
  /** Whether tools are being assigned to the agent */
  isAssigningTools?: boolean;
  /** Called to install browser (Playwright MCP) */
  onInstallBrowser?: () => Promise<unknown>;
  /** Called to assign Playwright tools to the current agent */
  onAssignToolsToAgent?: () => Promise<unknown>;
  /** Whether the browser requires reinstallation due to config change */
  reinstallRequired?: boolean;
  /** Whether the browser installation failed */
  installationFailed?: boolean;
  /** Called to reinstall the browser */
  onReinstallBrowser?: () => Promise<unknown>;
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
  isInstallingBrowser = false,
  hasPlaywrightMcpTools = false,
  isPlaywrightInstalledByCurrentUser = false,
  isAssigningTools = false,
  onInstallBrowser,
  onAssignToolsToAgent,
  reinstallRequired = false,
  installationFailed = false,
  onReinstallBrowser,
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
      isInstallingBrowser={isInstallingBrowser}
      hasPlaywrightMcpTools={hasPlaywrightMcpTools}
      isPlaywrightInstalledByCurrentUser={isPlaywrightInstalledByCurrentUser}
      isAssigningTools={isAssigningTools}
      onInstallBrowser={onInstallBrowser}
      onAssignToolsToAgent={onAssignToolsToAgent}
      reinstallRequired={reinstallRequired}
      installationFailed={installationFailed}
      onReinstallBrowser={onReinstallBrowser}
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
