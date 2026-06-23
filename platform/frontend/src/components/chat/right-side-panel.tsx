"use client";

import { AppWindow, FileText, Globe, PanelRightClose } from "lucide-react";
import { useEffect, useRef } from "react";
import { useApps } from "@/components/chat/apps-context";
import { BrowserPanel } from "@/components/chat/browser-panel";
import { ConversationFilesPanel } from "@/components/chat/conversation-files-panel";
import { ResizableRightPanel } from "@/components/chat/resizable-right-panel";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";

export type RightPanelTab = "files" | "browser" | "apps";

interface RightSidePanelProps {
  isOpen: boolean;
  activeTab: RightPanelTab;
  onTabChange: (tab: RightPanelTab) => void;
  onClose: () => void;
  canShowBrowser: boolean;

  // Artifact props
  artifact?: string | null;

  // Browser props
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

export function RightSidePanel({
  isOpen,
  activeTab,
  onTabChange,
  onClose,
  canShowBrowser,
  artifact,
  conversationId,
  agentId,
  onCreateConversationWithUrl,
  isCreatingConversation = false,
  initialNavigateUrl,
  onInitialNavigateComplete,
}: RightSidePanelProps) {
  const { apps, selectedToolCallId, select, setPortalTarget } = useApps();
  const portalDivRef = useRef<HTMLDivElement | null>(null);

  let resolvedTab: RightPanelTab = activeTab;
  if (resolvedTab === "browser" && !canShowBrowser) resolvedTab = "files";

  // Activate the portal target only while the Apps tab is showing — when the
  // user switches to artifact/browser or closes the panel, the app falls back
  // to inline rendering in the chat.
  useEffect(() => {
    const shouldHostApp = isOpen && resolvedTab === "apps";
    setPortalTarget(shouldHostApp ? portalDivRef.current : null);
    return () => {
      setPortalTarget(null);
    };
  }, [isOpen, resolvedTab, setPortalTarget]);

  if (!isOpen) {
    return null;
  }

  return (
    <ResizableRightPanel>
      <Tabs
        value={resolvedTab}
        onValueChange={(value) => onTabChange(value as RightPanelTab)}
        className="flex-1 min-h-0 flex flex-col gap-0"
      >
        <div className="flex items-center gap-2 border-b px-2 py-2">
          {/* Tabs take the remaining space and scroll horizontally when the
              panel is too narrow, so the action buttons on the right are never
              clipped. */}
          <div className="min-w-0 flex-1 overflow-x-auto">
            <TabsList className="h-8 w-max">
              <TabsTrigger value="files" className="text-xs px-3">
                <FileText className="h-3 w-3" />
                Files
              </TabsTrigger>
              {canShowBrowser && (
                <TabsTrigger value="browser" className="text-xs px-3">
                  <Globe className="h-3 w-3" />
                  Browser
                </TabsTrigger>
              )}
              <TabsTrigger value="apps" className="text-xs px-3">
                <AppWindow className="h-3 w-3" />
                Apps
              </TabsTrigger>
            </TabsList>
          </div>
          <div className="flex items-center gap-1 shrink-0">
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              onClick={onClose}
              title="Close panel"
            >
              <PanelRightClose className="h-4 w-4" />
              <span className="sr-only">Close panel</span>
            </Button>
          </div>
        </div>

        <div className="flex-1 min-h-0 overflow-hidden relative">
          {resolvedTab === "files" && (
            <ConversationFilesPanel
              conversationId={conversationId}
              artifact={artifact}
              onClose={onClose}
            />
          )}
          {resolvedTab === "browser" && canShowBrowser && (
            <BrowserPanel
              isOpen
              onClose={onClose}
              conversationId={conversationId}
              agentId={agentId}
              onCreateConversationWithUrl={onCreateConversationWithUrl}
              isCreatingConversation={isCreatingConversation}
              initialNavigateUrl={initialNavigateUrl}
              onInitialNavigateComplete={onInitialNavigateComplete}
              hideHeader
            />
          )}
          {/* Apps tab content: selector + portal target. */}
          {resolvedTab === "apps" && (
            <div className="flex flex-col h-full">
              {apps.length > 0 ? (
                <div className="flex items-center gap-2 border-b px-2 py-2">
                  <Select
                    value={selectedToolCallId ?? undefined}
                    onValueChange={(value) => select(value)}
                  >
                    <SelectTrigger className="flex-1 h-8 text-xs">
                      <SelectValue placeholder="Choose an App" />
                    </SelectTrigger>
                    <SelectContent>
                      {apps.map((app) => (
                        <SelectItem key={app.toolCallId} value={app.toolCallId}>
                          <span className="truncate">{app.label}</span>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              ) : null}
              <div ref={portalDivRef} className="flex-1 min-h-0 relative">
                {apps.length === 0 && (
                  <div className="absolute inset-0 flex flex-col items-center justify-center text-center text-xs text-muted-foreground px-6">
                    <AppWindow className="h-6 w-6 mb-2 opacity-50" />
                    <p className="font-medium">No Apps in this chat</p>
                    <p className="mt-1">
                      Apps from tool calls in this conversation will appear
                      here.
                    </p>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </Tabs>
    </ResizableRightPanel>
  );
}
