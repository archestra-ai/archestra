"use client";

import { GripVertical } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { BrowserPanel } from "@/components/chat/browser-panel";
import { ConversationArtifactPanel } from "@/components/chat/conversation-artifact";
import { cn } from "@/lib/utils";

interface RightSidePanelProps {
  // Artifact props
  artifact?: string | null;
  isArtifactOpen: boolean;
  onArtifactToggle: () => void;

  // Browser props
  isBrowserOpen: boolean;
  onBrowserClose: () => void;
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
  artifact,
  isArtifactOpen,
  onArtifactToggle,
  isBrowserOpen,
  onBrowserClose,
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

  // Don't render if nothing is open
  if (!isArtifactOpen && !isBrowserOpen) {
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

      {/* Artifact Panel - takes remaining space */}
      {isArtifactOpen && (
        <div
          className="min-h-0 overflow-hidden"
          style={{
            height: isBrowserOpen ? "50%" : "100%",
          }}
        >
          <ConversationArtifactPanel
            artifact={artifact}
            isOpen={isArtifactOpen}
            onToggle={onArtifactToggle}
            embedded
          />
        </div>
      )}

      {/* Browser Panel - at the bottom */}
      {isBrowserOpen && (
        <div
          className="flex-shrink-0"
          style={{
            height: isArtifactOpen ? "50%" : "unset",
          }}
        >
          <BrowserPanel
            isOpen={isBrowserOpen}
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
