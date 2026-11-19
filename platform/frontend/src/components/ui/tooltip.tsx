"use client";

import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import type * as React from "react";
import { useCallback } from "react";

import { cn } from "@/lib/utils/tailwind";

function TooltipProvider({
  delayDuration = 0,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Provider>) {
  return (
    <TooltipPrimitive.Provider
      data-slot="tooltip-provider"
      delayDuration={delayDuration}
      {...props}
    />
  );
}

function Tooltip({
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Root>) {
  return (
    <TooltipProvider>
      <TooltipPrimitive.Root data-slot="tooltip" {...props} />
    </TooltipProvider>
  );
}

function TooltipTrigger({
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Trigger>) {
  return <TooltipPrimitive.Trigger data-slot="tooltip-trigger" {...props} />;
}

function TooltipContent({
  className,
  sideOffset = 6,
  children,
  noArrow = true,
  ref,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Content> & {
  noArrow?: boolean;
}) {
  const contentRef = useCallback(
    (node: HTMLDivElement | null) => {
      if (node) shrinkToWrappedText(node);
      if (typeof ref === "function") return ref(node);
      if (ref) ref.current = node;
    },
    [ref],
  );
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        ref={contentRef}
        data-slot="tooltip-content"
        sideOffset={sideOffset}
        className={cn(
          "bg-popover text-popover-foreground border animate-in fade-in-0 zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 z-50 w-fit origin-(--radix-tooltip-content-transform-origin) rounded-md px-3 py-1.5 text-xs text-balance shadow-md",
          className,
        )}
        {...props}
      >
        {children}
        {!noArrow && (
          <span className="[&>span]:z-[-50]">
            <TooltipPrimitive.Arrow className="bg-popover fill-popover border z-50 size-2.5 translate-y-[calc(-50%_-_2px)] rotate-45 rounded-[2px]" />
          </span>
        )}
      </TooltipPrimitive.Content>
    </TooltipPrimitive.Portal>
  );
}

export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider };

// ===

/**
 * Wrapped text leaves its box as wide as the max width allows, and
 * `text-balance` only evens out the lines inside it, so a two-line tooltip
 * shows a band of empty space on its right. CSS cannot shrink a box to its
 * widest wrapped line, so this measures that line and sets the width to it.
 * Content laid out in blocks (lists, rows) measures as wide as the box and
 * is left alone.
 */
function shrinkToWrappedText(node: HTMLElement) {
  node.style.width = "";
  const range = document.createRange();
  // Test DOMs have no layout to measure.
  if (typeof range.getClientRects !== "function") return;
  // Radix repeats the content in a visually hidden `role="tooltip"` copy for
  // screen readers; only the visible content counts.
  const lines = Array.from(node.childNodes)
    .filter(
      (child) =>
        !(child instanceof Element && child.getAttribute("role") === "tooltip"),
    )
    .flatMap((child) => {
      range.selectNode(child);
      return Array.from(range.getClientRects());
    })
    .filter((rect) => rect.width > 0);
  if (lines.length < 2) return;
  // The opening zoom scales the box, and its client rects with it.
  const scale = node.getBoundingClientRect().width / node.offsetWidth || 1;
  const textWidth =
    (Math.max(...lines.map((rect) => rect.right)) -
      Math.min(...lines.map((rect) => rect.left))) /
    scale;
  const style = getComputedStyle(node);
  const chrome =
    Number.parseFloat(style.paddingLeft) +
    Number.parseFloat(style.paddingRight) +
    Number.parseFloat(style.borderLeftWidth) +
    Number.parseFloat(style.borderRightWidth);
  const width = Math.ceil(textWidth + chrome);
  if (width < node.offsetWidth - 1) node.style.width = `${width}px`;
}
