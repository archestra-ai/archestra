"use client";

import { GripVertical } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/utils";

/** Smallest the panel itself may shrink to. */
const MIN_PANEL_WIDTH = 300;
/** Width the main content column must always keep so it never squashes. */
const MIN_CONTENT_WIDTH = 400;
/** Shared across surfaces so the panel keeps its width from page to page. */
const WIDTH_STORAGE_KEY = "archestra-right-panel-width";

/**
 * The chat page's right-side panel shell, extracted so other pages (e.g. a
 * project's Files sidebar) get the exact same look and behavior: full-height
 * `border-l` column with a drag handle on its left edge, width persisted to
 * localStorage and clamped so the content column never squashes.
 *
 * Expects to be nested two levels under the layout row (row > wrapper >
 * panel): the max width is measured from the grandparent element.
 */
export function ResizableRightPanel({
  children,
}: {
  children: React.ReactNode;
}) {
  const [width, setWidth] = useState(() => {
    if (typeof window !== "undefined") {
      const saved = localStorage.getItem(WIDTH_STORAGE_KEY);
      return saved ? Number.parseInt(saved, 10) : 500;
    }
    return 500;
  });
  const [isResizing, setIsResizing] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);

  // Largest the panel may grow to: the width of the layout row (content
  // column + this panel) minus the minimum content column width. The panel's
  // direct parent is a tight flex wrapper whose width equals the panel, so we
  // measure its parent — the row — which spans the whole content area
  // (everything right of the left nav). Falls back to the viewport before
  // layout exists.
  const getMaxWidth = useCallback(() => {
    const row = panelRef.current?.parentElement?.parentElement;
    const available =
      row?.getBoundingClientRect().width ??
      (typeof window !== "undefined" ? window.innerWidth : 0);
    return Math.max(MIN_PANEL_WIDTH, available - MIN_CONTENT_WIDTH);
  }, []);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setIsResizing(true);
  }, []);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const step = e.shiftKey ? 50 : 10; // Larger step with shift key
      const maxWidth = getMaxWidth();

      if (e.key === "ArrowLeft") {
        e.preventDefault();
        const newWidth = Math.min(maxWidth, width + step);
        setWidth(newWidth);
        localStorage.setItem(WIDTH_STORAGE_KEY, newWidth.toString());
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        const newWidth = Math.max(MIN_PANEL_WIDTH, width - step);
        setWidth(newWidth);
        localStorage.setItem(WIDTH_STORAGE_KEY, newWidth.toString());
      }
    },
    [width, getMaxWidth],
  );

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isResizing) return;

      const newWidth = window.innerWidth - e.clientX;
      const clampedWidth = Math.max(
        MIN_PANEL_WIDTH,
        Math.min(getMaxWidth(), newWidth),
      );
      setWidth(clampedWidth);
      localStorage.setItem(WIDTH_STORAGE_KEY, clampedWidth.toString());
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
  }, [isResizing, getMaxWidth]);

  // Keep the panel within bounds when the window resizes (or on first mount),
  // so a previously-saved width never squashes the content column.
  useEffect(() => {
    const clamp = () => {
      setWidth((prev) =>
        Math.max(MIN_PANEL_WIDTH, Math.min(getMaxWidth(), prev)),
      );
    };
    clamp();
    window.addEventListener("resize", clamp);
    return () => window.removeEventListener("resize", clamp);
  }, [getMaxWidth]);

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
        aria-valuemin={MIN_PANEL_WIDTH}
        aria-valuemax={getMaxWidth()}
        tabIndex={0}
      >
        <div className="absolute left-0 top-1/2 -translate-y-1/2 -translate-x-1/2 opacity-0 hover:opacity-100 transition-opacity">
          <GripVertical className="h-4 w-4 text-muted-foreground" />
        </div>
      </div>

      {/* While dragging, a transparent full-viewport overlay sits above any
          iframes (MCP App / Browser tabs / HTML previews) so they don't
          swallow the mouse events that drive the resize — without it, the
          resize freezes the moment the cursor crosses an iframe. */}
      {isResizing &&
        typeof document !== "undefined" &&
        createPortal(
          <div
            className="fixed inset-0 z-[9999] cursor-col-resize"
            aria-hidden
          />,
          document.body,
        )}

      {children}
    </div>
  );
}
