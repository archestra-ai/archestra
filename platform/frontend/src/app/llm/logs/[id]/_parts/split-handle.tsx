"use client";

import { useRef, useState } from "react";
import { flushSync } from "react-dom";
import { cn } from "@/lib/utils/tailwind";

export const DETAILS_PANE_DEFAULT_HEIGHT = 480;

/**
 * The drag bar between the request list and the details pane. Drag, or focus
 * it and use the arrow keys; double-click restores the default height. Phones
 * stack the details at their natural height, so it only exists from `lg`.
 *
 * The page scrolls rather than fitting the viewport, so growing the details
 * pane alone would push its bottom edge down and leave the bar where it was.
 * Each resize scrolls the page by the same amount instead: the bar stays
 * under the pointer and the pane opens upward over the request list.
 */
export function SplitHandle({
  height,
  onChange,
}: {
  height: number;
  onChange: (height: number) => void;
}) {
  const drag = useRef<{ y: number; h: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const clamp = (h: number) =>
    Math.min(PANE_MAX, Math.max(PANE_MIN, Math.round(h)));
  const stop = () => {
    drag.current = null;
    setDragging(false);
  };
  const resize = (element: HTMLElement, next: number) => {
    const delta = clamp(next) - height;
    if (delta === 0) return;
    flushSync(() => onChange(height + delta));
    scrollParentOf(element).scrollBy({ top: delta });
  };

  return (
    // A hairline in the layout with a faint grip pill on it, and a taller
    // invisible grab strip over both: the split reads as a divider, not as a
    // band of its own, yet still shows it can be dragged.
    <div className="relative hidden h-px bg-border transition-colors has-[[role=separator]:hover]:bg-muted-foreground/40 has-[[role=separator]:focus-visible]:bg-muted-foreground/40 lg:block">
      {/* biome-ignore lint/a11y/useSemanticElements: a focusable splitter has no native element. */}
      <div
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize request details"
        aria-valuemin={PANE_MIN}
        aria-valuemax={PANE_MAX}
        aria-valuenow={height}
        tabIndex={0}
        onPointerDown={(event) => {
          drag.current = { y: event.clientY, h: height };
          event.currentTarget.setPointerCapture(event.pointerId);
          setDragging(true);
        }}
        onPointerMove={(event) => {
          if (!drag.current) return;
          resize(
            event.currentTarget,
            drag.current.h - (event.clientY - drag.current.y),
          );
        }}
        onPointerUp={stop}
        onPointerCancel={stop}
        onLostPointerCapture={stop}
        onDoubleClick={(event) =>
          resize(event.currentTarget, DETAILS_PANE_DEFAULT_HEIGHT)
        }
        onKeyDown={(event) => {
          if (event.key === "ArrowUp") {
            event.preventDefault();
            resize(event.currentTarget, height + KEY_STEP);
          } else if (event.key === "ArrowDown") {
            event.preventDefault();
            resize(event.currentTarget, height - KEY_STEP);
          }
        }}
        className="group absolute inset-x-0 -top-1 z-10 flex h-2 cursor-row-resize touch-none items-center justify-center outline-none select-none"
      >
        <span
          aria-hidden="true"
          className={cn(
            "h-1 w-9 rounded-full bg-muted-foreground/35 ring-2 ring-background transition-[width,background-color] group-hover:w-12 group-hover:bg-muted-foreground/70 group-focus-visible:w-12 group-focus-visible:bg-muted-foreground/70",
            dragging && "w-12 bg-primary/80 group-hover:bg-primary/80",
          )}
        />
      </div>
    </div>
  );
}

// ============================================================================
// Internal helpers
// ============================================================================

const PANE_MIN = 260;
const PANE_MAX = 820;
const KEY_STEP = 32;

function scrollParentOf(element: HTMLElement): Element {
  for (let node = element.parentElement; node; node = node.parentElement) {
    const { overflowY } = getComputedStyle(node);
    if (
      (overflowY === "auto" || overflowY === "scroll") &&
      node.scrollHeight > node.clientHeight
    ) {
      return node;
    }
  }
  return document.scrollingElement ?? document.documentElement;
}
