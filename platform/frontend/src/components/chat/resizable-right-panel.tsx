"use client";

import { GripVertical } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

/** Smallest the panel itself may shrink to. */
const MIN_PANEL_WIDTH = 300;
/**
 * Width the main content column must always keep so it never squashes. Sized so
 * the chat composer's footer toolbar stays uncramped at its narrowest: the Apps
 * Hackathon recorder pill is fixed-width and sits between the (collapsible) tool
 * row and the fixed send/mic controls, so the column needs a little extra width
 * to keep a clear gap there — even as the recorder's live timer widens during a
 * capture — rather than the pill and mic crowding together.
 */
const MIN_CONTENT_WIDTH = 420;
/** Shared across surfaces so the panel keeps its width from page to page. */
export const RIGHT_PANEL_WIDTH_STORAGE_KEY = "archestra-right-panel-width";
/** Panel width before the user has ever resized it. */
export const DEFAULT_RIGHT_PANEL_WIDTH = 500;

/**
 * The panel width that gives a `ratio`-shaped (width : height) panel at
 * `height`, clamped to the same bounds user resizing respects — an aspect
 * lock may demand a shape, never a squashed content column.
 *
 * @public — exported for testability
 */
export function aspectLockedPanelWidth({
  height,
  ratio,
  minWidth,
  maxWidth,
}: {
  height: number;
  ratio: number;
  minWidth: number;
  maxWidth: number;
}): number {
  return Math.max(minWidth, Math.min(maxWidth, Math.round(height * ratio)));
}

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
  aspectLock,
}: {
  children: React.ReactNode;
  /**
   * Lock the panel to `ratio` × its own height (width : height) and disable
   * resizing while set — the drag handle stays visible, inert, and explains
   * itself with `hint`. The session recorder locks the panel to the shape the
   * replay player shows the app at, so what is recorded is what plays back.
   * The lock never outranks the layout's own bounds: on a window too narrow
   * to grant the full ratio the content column's minimum wins and the panel
   * takes what is left (the replay contain-fits whatever shape was actually
   * captured). The locked width persists exactly like a user resize, so when
   * the lock clears the panel stays put — no jump — and simply becomes
   * resizable again.
   */
  aspectLock?: { ratio: number; hint: string };
}) {
  const [width, setWidth] = useState(() => {
    if (typeof window !== "undefined") {
      const saved = localStorage.getItem(RIGHT_PANEL_WIDTH_STORAGE_KEY);
      return saved ? Number.parseInt(saved, 10) : DEFAULT_RIGHT_PANEL_WIDTH;
    }
    return DEFAULT_RIGHT_PANEL_WIDTH;
  });
  const [isResizing, setIsResizing] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const lockRatio = aspectLock?.ratio;
  const locked = lockRatio !== undefined;

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

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      if (locked) return;
      setIsResizing(true);
    },
    [locked],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (locked) return;
      const step = e.shiftKey ? 50 : 10; // Larger step with shift key
      const maxWidth = getMaxWidth();

      if (e.key === "ArrowLeft") {
        e.preventDefault();
        const newWidth = Math.min(maxWidth, width + step);
        setWidth(newWidth);
        localStorage.setItem(
          RIGHT_PANEL_WIDTH_STORAGE_KEY,
          newWidth.toString(),
        );
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        const newWidth = Math.max(MIN_PANEL_WIDTH, width - step);
        setWidth(newWidth);
        localStorage.setItem(
          RIGHT_PANEL_WIDTH_STORAGE_KEY,
          newWidth.toString(),
        );
      }
    },
    [width, getMaxWidth, locked],
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
      localStorage.setItem(
        RIGHT_PANEL_WIDTH_STORAGE_KEY,
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

  // While locked, the panel's width follows its own height at the locked
  // ratio (the panel is full-height, so this tracks window resizes too),
  // written through the ordinary width state + localStorage — a lock update
  // IS a resize, just machine-driven. That way the lock clearing moves
  // nothing: the panel stays at the shape the recording set and simply
  // becomes hand-resizable again.
  useEffect(() => {
    if (lockRatio === undefined) return;
    // A lock engaging mid-drag wins: the drag ends where it was.
    setIsResizing(false);
    const el = panelRef.current;
    if (!el) return;
    const update = () => {
      const next = aspectLockedPanelWidth({
        height: el.clientHeight,
        ratio: lockRatio,
        minWidth: MIN_PANEL_WIDTH,
        maxWidth: getMaxWidth(),
      });
      setWidth(next);
      localStorage.setItem(RIGHT_PANEL_WIDTH_STORAGE_KEY, next.toString());
    };
    update();
    // The observer tracks the panel's own box (its height drives the width),
    // but the max-width bound moves with the WINDOW's width — which doesn't
    // resize the panel's box — so re-clamp on window resize too.
    const observer = new ResizeObserver(update);
    observer.observe(el);
    window.addEventListener("resize", update);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", update);
    };
  }, [lockRatio, getMaxWidth]);

  const handle = (
    // biome-ignore lint/a11y/useSemanticElements: This is a draggable resize handle, not a semantic separator
    <div
      className={cn(
        "absolute left-0 top-0 bottom-0 w-1 bg-transparent transition-all z-10",
        locked
          ? "cursor-not-allowed"
          : "hover:w-2 cursor-col-resize hover:bg-primary/10",
      )}
      onMouseDown={handleMouseDown}
      onKeyDown={handleKeyDown}
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize panel. Use arrow keys to resize, hold shift for larger steps."
      aria-disabled={locked || undefined}
      aria-valuenow={width}
      aria-valuemin={MIN_PANEL_WIDTH}
      aria-valuemax={getMaxWidth()}
      tabIndex={locked ? -1 : 0}
    >
      <div className="absolute left-0 top-1/2 -translate-y-1/2 -translate-x-1/2 opacity-0 hover:opacity-100 transition-opacity">
        <GripVertical className="h-4 w-4 text-muted-foreground" />
      </div>
    </div>
  );

  return (
    <div
      ref={panelRef}
      style={{ width: `${width}px` }}
      className={cn("h-full border-l bg-background flex flex-col relative")}
    >
      {/* Resize handle; while aspect-locked it only explains the lock. */}
      {aspectLock ? (
        <TooltipProvider delayDuration={200}>
          <Tooltip>
            <TooltipTrigger asChild>{handle}</TooltipTrigger>
            <TooltipContent side="left" className="max-w-[240px] text-xs">
              {aspectLock.hint}
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      ) : (
        handle
      )}

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
