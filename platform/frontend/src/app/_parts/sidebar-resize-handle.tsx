"use client";

import {
  type KeyboardEvent,
  type PointerEvent,
  useCallback,
  useState,
  useSyncExternalStore,
} from "react";
import { useSidebar } from "@/components/ui/sidebar";
import { cn } from "@/lib/utils/tailwind";

/**
 * The sidebar's width: the person's own last drag, remembered in this
 * browser, and the default until they make one. `resizing` is true while a
 * drag is under way, so the shell can drop its width transition.
 */
export function useSidebarWidthState() {
  const [choice, setChoice] = useState<number | null>(null);
  const [resizing, setResizing] = useState(false);
  const remembered = useSyncExternalStore(
    subscribeToStorage,
    readRememberedSidebarWidth,
    () => null,
  );

  const width = choice ?? remembered ?? SIDEBAR_DEFAULT_WIDTH;
  const setWidth = useCallback((next: number) => {
    const clamped = clampWidth(next);
    setChoice(clamped);
    try {
      window.localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(clamped));
    } catch {
      // Storage can be unavailable (private mode); the width still holds
      // for this page.
    }
  }, []);

  return { width, setWidth, resizing, setResizing };
}

/**
 * Drag handle on the sidebar's right edge, open or collapsed. Dragging well
 * past the minimum width collapses the sidebar, and dragging the collapsed
 * rail out opens it again, both within one drag. Arrow keys resize it too
 * (and open a collapsed one), and a double-click puts it back to the default
 * width.
 */
export function SidebarResizeHandle({
  width,
  onWidthChange,
  onResizingChange,
}: {
  width: number;
  onWidthChange: (width: number) => void;
  onResizingChange: (resizing: boolean) => void;
}) {
  const { state, isMobile, setOpen } = useSidebar();
  if (isMobile) return null;
  const collapsed = state === "collapsed";

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const handle = event.currentTarget;
    handle.setPointerCapture(event.pointerId);
    const startX = event.clientX;
    // A collapsed sidebar starts from its rail; reopening it restores the
    // width it had before it collapsed.
    const startWidth = collapsed ? SIDEBAR_RAIL_WIDTH : width;
    const restoreWidth = width;
    let open = !collapsed;
    onResizingChange(true);
    const onMove = (move: globalThis.PointerEvent) => {
      const next = startWidth + move.clientX - startX;
      if (next < SIDEBAR_COLLAPSE_WIDTH) {
        if (!open) return;
        open = false;
        onWidthChange(collapsed ? restoreWidth : startWidth);
        setOpen(false);
        return;
      }
      if (!open) {
        open = true;
        setOpen(true);
      }
      onWidthChange(next);
    };
    const onUp = () => {
      onResizingChange(false);
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onUp);
      handle.removeEventListener("pointercancel", onUp);
    };
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp);
    handle.addEventListener("pointercancel", onUp);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? 40 : 10;
    if (collapsed) {
      if (event.key !== "ArrowRight" && event.key !== "Enter") return;
      event.preventDefault();
      setOpen(true);
      return;
    }
    if (event.key === "ArrowLeft") onWidthChange(width - step);
    else if (event.key === "ArrowRight") onWidthChange(width + step);
    else if (event.key === "Home") onWidthChange(SIDEBAR_MIN_WIDTH);
    else if (event.key === "End") onWidthChange(SIDEBAR_MAX_WIDTH);
    else return;
    event.preventDefault();
  };

  return (
    // A focusable separator is the ARIA pattern for a resize handle.
    // biome-ignore lint/a11y/useSemanticElements: <hr> cannot take focus or be dragged
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize sidebar"
      aria-valuenow={width}
      aria-valuemin={SIDEBAR_MIN_WIDTH}
      aria-valuemax={SIDEBAR_MAX_WIDTH}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
      onDoubleClick={() => {
        onWidthChange(SIDEBAR_DEFAULT_WIDTH);
        if (collapsed) setOpen(true);
      }}
      className={cn(
        "fixed inset-y-0 z-20 hidden w-2 -translate-x-1/2 cursor-col-resize touch-none md:block",
        collapsed ? "left-(--sidebar-width-icon)" : "left-(--sidebar-width)",
        "outline-none",
        "after:absolute after:inset-y-0 after:left-1/2 after:w-px after:-translate-x-1/2 after:transition-colors",
        "hover:after:w-0.5 hover:after:bg-sidebar-border focus-visible:after:w-0.5 focus-visible:after:bg-ring",
      )}
    />
  );
}

const SIDEBAR_DEFAULT_WIDTH = 240;
const SIDEBAR_MIN_WIDTH = 200;
const SIDEBAR_MAX_WIDTH = 480;
// Below this the drag closes the sidebar. The gap past the minimum keeps a
// drag that only overshoots the minimum from closing it.
const SIDEBAR_COLLAPSE_WIDTH = SIDEBAR_MIN_WIDTH - 60;
// The collapsed icon rail, `--sidebar-width-icon` (3rem).
const SIDEBAR_RAIL_WIDTH = 48;
const SIDEBAR_WIDTH_STORAGE_KEY = "archestra-sidebar-width";

function clampWidth(width: number) {
  return Math.round(
    Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, width)),
  );
}

function readRememberedSidebarWidth(): number | null {
  try {
    const stored = Number(
      window.localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY),
    );
    return Number.isFinite(stored) && stored > 0 ? clampWidth(stored) : null;
  } catch {
    return null;
  }
}

function subscribeToStorage(onChange: () => void) {
  window.addEventListener("storage", onChange);
  return () => window.removeEventListener("storage", onChange);
}
