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
  isBrowserMinimized: boolean;
  onBrowserMinimizeToggle: () => void;
  onBrowserClose: () => void;
  conversationId: string | undefined;
}

export function RightSidePanel({
  artifact,
  isArtifactOpen,
  onArtifactToggle,
  isBrowserOpen,
  isBrowserMinimized,
  onBrowserMinimizeToggle,
  onBrowserClose,
  conversationId,
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
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize panel"
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
            flex: isBrowserOpen && !isBrowserMinimized ? "1 1 50%" : "1 1 100%",
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
            height: isBrowserMinimized ? 40 : undefined,
            flex:
              !isBrowserMinimized && isArtifactOpen
                ? "1 1 50%"
                : !isBrowserMinimized
                  ? "1 1 100%"
                  : undefined,
          }}
        >
          <BrowserPanel
            isOpen={isBrowserOpen}
            onClose={onBrowserClose}
            conversationId={conversationId}
            isMinimized={isBrowserMinimized}
            onMinimizeToggle={onBrowserMinimizeToggle}
          />
        </div>
      )}
    </div>
  );
}
