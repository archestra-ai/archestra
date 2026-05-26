"use client";

import { format } from "date-fns";
import { FileText, Globe, GripVertical, Pin, PinOff, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { BrowserPanel } from "@/components/chat/browser-panel";
import { ConversationArtifactPanel } from "@/components/chat/conversation-artifact";
import { usePinnedCanvas } from "@/components/chat/pinned-canvas-context";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";

export type RightPanelTab = "artifact" | "browser" | "canvas";

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
  const [width, setWidth] = useState(() => {
    if (typeof window !== "undefined") {
      const saved = localStorage.getItem("archestra-right-panel-width");
      return saved ? Number.parseInt(saved, 10) : 500;
    }
    return 500;
  });
  const [isResizing, setIsResizing] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setIsResizing(true);
  }, []);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const step = e.shiftKey ? 50 : 10; // Larger step with shift key
      const minWidth = 300;
      const maxWidth = window.innerWidth * 0.7;

      if (e.key === "ArrowLeft") {
        e.preventDefault();
        const newWidth = Math.min(maxWidth, width + step);
        setWidth(newWidth);
        localStorage.setItem(
          "archestra-right-panel-width",
          newWidth.toString(),
        );
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        const newWidth = Math.max(minWidth, width - step);
        setWidth(newWidth);
        localStorage.setItem(
          "archestra-right-panel-width",
          newWidth.toString(),
        );
      }
    },
    [width],
  );

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isResizing) return;

      const newWidth = window.innerWidth - e.clientX;
      const minWidth = 300;
      const maxWidth = window.innerWidth * 0.7;

      const clampedWidth = Math.max(minWidth, Math.min(maxWidth, newWidth));
      setWidth(clampedWidth);
      localStorage.setItem(
        "archestra-right-panel-width",
        clampedWidth.toString(),
      );
    };

    const handleMouseUp = () => {
      setIsResizing(false);
    };

    if (isResizing) {
      document.addEventListener("mousemove", handleMouseMove);
      document.addEventListener("mouseup", handleMouseUp);
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
    }

    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
  }, [isResizing]);

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
  if (resolvedTab === "browser" && !canShowBrowser) resolvedTab = "artifact";

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
    <div
      ref={panelRef}
      style={{ width: `${width}px` }}
      className={cn("h-full border-l bg-background flex flex-col relative")}
    >
      {/* Resize handle */}
      {/* biome-ignore lint/a11y/useSemanticElements: This is a draggable resize handle, not a semantic separator */}
      <div
        className="absolute left-0 top-0 bottom-0 w-1 hover:w-2 cursor-col-resize bg-transparent hover:bg-primary/10 transition-all z-10"
        onMouseDown={handleMouseDown}
        onKeyDown={handleKeyDown}
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize panel. Use arrow keys to resize, hold shift for larger steps."
        aria-valuenow={width}
        aria-valuemin={300}
        aria-valuemax={
          typeof window !== "undefined" ? window.innerWidth * 0.7 : 1000
        }
        tabIndex={0}
      >
        <div className="absolute left-0 top-1/2 -translate-y-1/2 -translate-x-1/2 opacity-0 hover:opacity-100 transition-opacity">
          <GripVertical className="h-4 w-4 text-muted-foreground" />
        </div>
      </div>

      <Tabs
        value={resolvedTab}
        onValueChange={(value) => onTabChange(value as RightPanelTab)}
        className="flex-1 min-h-0 flex flex-col gap-0"
      >
        <div className="flex items-center justify-between gap-2 border-b px-2 py-2">
          <TabsList className="h-8">
            <TabsTrigger value="artifact" className="text-xs px-3">
              <FileText className="h-3 w-3" />
              Artifact
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
          <div className="flex items-center gap-1">
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
          {resolvedTab === "artifact" && (
            <ConversationArtifactPanel
              artifact={artifact}
              isOpen
              onToggle={onClose}
              embedded
              hideHeader
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
    </div>
  );
}
