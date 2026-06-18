"use client";

import { format } from "date-fns";
import { FileText, Globe, Pin, PinOff, X } from "lucide-react";
import { useEffect, useRef } from "react";
import { BrowserPanel } from "@/components/chat/browser-panel";
import { ConversationFilesPanel } from "@/components/chat/conversation-files-panel";
import { usePinnedCanvas } from "@/components/chat/pinned-canvas-context";
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

export type RightPanelTab = "files" | "browser" | "canvas";

interface RightSidePanelProps {
  isOpen: boolean;
  activeTab: RightPanelTab;
  onTabChange: (tab: RightPanelTab) => void;
  onClose: () => void;
  canShowBrowser: boolean;
  /** Optional action(s) rendered in the tab row, between the tabs and the close button. */
  headerActions?: React.ReactNode;

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
  headerActions,
  artifact,
  conversationId,
  agentId,
  onCreateConversationWithUrl,
  isCreatingConversation = false,
  initialNavigateUrl,
  onInitialNavigateComplete,
}: RightSidePanelProps) {
  const {
    canvases,
    pinnedCanvasId,
    selectedCanvasId,
    setPinned,
    select,
    setPortalTarget,
  } = usePinnedCanvas();
  const portalDivRef = useRef<HTMLDivElement | null>(null);

  let resolvedTab: RightPanelTab = activeTab;
  if (resolvedTab === "browser" && !canShowBrowser) resolvedTab = "files";

  // Activate the portal target only while the canvas tab is showing — when the
  // user switches to artifact/browser or closes the panel, the canvas falls
  // back to inline rendering in the chat.
  useEffect(() => {
    const shouldHostCanvas = isOpen && resolvedTab === "canvas";
    setPortalTarget(shouldHostCanvas ? portalDivRef.current : null);
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
              <TabsTrigger value="canvas" className="text-xs px-3">
                MCP App
              </TabsTrigger>
            </TabsList>
          </div>
          <div className="flex items-center gap-1 shrink-0">
            {headerActions}
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={onClose}
              title="Close panel"
            >
              <X className="h-4 w-4" />
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
          {/* Canvas tab content: selector + portal target. */}
          {resolvedTab === "canvas" && (
            <div className="flex flex-col h-full">
              {canvases.length > 0 ? (
                <div className="flex items-center gap-2 border-b px-2 py-2">
                  <Select
                    value={selectedCanvasId ?? undefined}
                    onValueChange={(value) => select(value)}
                  >
                    <SelectTrigger className="flex-1 h-8 text-xs">
                      <SelectValue placeholder="Choose an MCP App" />
                    </SelectTrigger>
                    <SelectContent>
                      {canvases.map((canvas) => (
                        <SelectItem
                          key={canvas.toolCallId}
                          value={canvas.toolCallId}
                        >
                          <div className="flex items-center gap-2 min-w-0">
                            <span className="truncate">{canvas.label}</span>
                            <span className="text-[10px] text-muted-foreground ml-auto whitespace-nowrap tabular-nums">
                              {format(canvas.createdAt, "HH:mm:ss")}
                            </span>
                          </div>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Button
                    variant={
                      pinnedCanvasId && pinnedCanvasId === selectedCanvasId
                        ? "secondary"
                        : "ghost"
                    }
                    size="icon"
                    className="h-8 w-8"
                    disabled={!selectedCanvasId}
                    onClick={() => {
                      if (!selectedCanvasId) return;
                      setPinned(
                        pinnedCanvasId === selectedCanvasId
                          ? null
                          : selectedCanvasId,
                      );
                    }}
                    title={
                      pinnedCanvasId === selectedCanvasId
                        ? "Unpin as default"
                        : "Pin as default for this conversation"
                    }
                    aria-label={
                      pinnedCanvasId === selectedCanvasId
                        ? "Unpin as default"
                        : "Pin as default"
                    }
                  >
                    {pinnedCanvasId === selectedCanvasId ? (
                      <PinOff className="h-4 w-4" />
                    ) : (
                      <Pin className="h-4 w-4" />
                    )}
                  </Button>
                </div>
              ) : null}
              <div ref={portalDivRef} className="flex-1 min-h-0 relative">
                {canvases.length === 0 && (
                  <div className="absolute inset-0 flex flex-col items-center justify-center text-center text-xs text-muted-foreground px-6">
                    <Pin className="h-6 w-6 mb-2 opacity-50" />
                    <p className="font-medium">No MCP Apps in this chat</p>
                    <p className="mt-1">
                      MCP Apps from tool calls in this conversation will appear
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
