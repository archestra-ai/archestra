"use client";

import { useCallback, useRef, useState } from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "./tooltip";

function hasOverflow(node: HTMLElement): boolean {
  if (node.scrollWidth > node.clientWidth) return true;
  for (const child of node.children) {
    if (child instanceof HTMLElement && hasOverflow(child)) return true;
  }
  return false;
}

/**
 * Wraps children in a tooltip that only appears when the text is
 * CSS-truncated (i.e. the element's scrollWidth exceeds its clientWidth).
 */
export function TruncatedTooltip({
  children,
  content,
}: {
  children: React.ReactNode;
  content: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const truncatedRef = useRef(false);

  const handleMouseEnter = useCallback(() => {
    const el = triggerRef.current;
    truncatedRef.current = !!el && hasOverflow(el);
    if (truncatedRef.current) {
      setOpen(true);
    }
  }, []);

  const handleMouseLeave = useCallback(() => {
    setOpen(false);
    truncatedRef.current = false;
  }, []);

  const handleOpenChange = useCallback((value: boolean) => {
    // Only allow opening if text is actually truncated
    if (value && !truncatedRef.current) return;
    setOpen(value);
  }, []);

  return (
    <Tooltip open={open} onOpenChange={handleOpenChange}>
      <TooltipTrigger
        asChild
        ref={triggerRef}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
        onFocus={handleMouseEnter}
        onBlur={handleMouseLeave}
      >
        {children}
      </TooltipTrigger>
      <TooltipContent>{content}</TooltipContent>
    </Tooltip>
  );
}
