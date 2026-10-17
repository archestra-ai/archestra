"use client";

import { useRef, useState } from "react";
import { cn } from "@/lib/utils/tailwind";

export const DETAILS_PANE_DEFAULT_HEIGHT = 480;

/**
 * The drag bar between the request list and the details pane. Drag, or focus
 * it and use the arrow keys; double-click restores the default height. Phones
 * stack the details at their natural height, so it only exists from `lg`.
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

  return (
    // biome-ignore lint/a11y/useSemanticElements: a focusable splitter has no native element.
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
        onChange(clamp(drag.current.h - (event.clientY - drag.current.y)));
      }}
      onPointerUp={stop}
      onPointerCancel={stop}
      onDoubleClick={() => onChange(DETAILS_PANE_DEFAULT_HEIGHT)}
      onKeyDown={(event) => {
        if (event.key === "ArrowUp") {
          event.preventDefault();
          onChange(clamp(height + KEY_STEP));
        } else if (event.key === "ArrowDown") {
          event.preventDefault();
          onChange(clamp(height - KEY_STEP));
        }
      }}
      className={cn(
        "group hidden h-2.5 cursor-row-resize touch-none items-center justify-center border-y bg-muted/60 outline-none transition-colors select-none lg:flex",
        "hover:bg-muted focus-visible:bg-muted focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-inset",
        dragging && "bg-primary/10",
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          "h-[3px] w-10 rounded-full bg-muted-foreground/30 transition-colors group-hover:bg-muted-foreground/60",
          dragging && "bg-primary/70 group-hover:bg-primary/70",
        )}
      />
    </div>
  );
}

// ============================================================================
// Internal helpers
// ============================================================================

const PANE_MIN = 260;
const PANE_MAX = 820;
const KEY_STEP = 32;
