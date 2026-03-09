"use client";

import { useCallback, useRef, useState } from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "./tooltip";

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
  const [isTruncated, setIsTruncated] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  const checkTruncation = useCallback(() => {
    const el = triggerRef.current;
    if (el) {
      // Check the trigger element itself, or its first child if it's used with asChild
      const target =
        el.scrollWidth > el.clientWidth ? el : (el.firstElementChild as HTMLElement | null);
      setIsTruncated(
        el.scrollWidth > el.clientWidth ||
          (target ? target.scrollWidth > target.clientWidth : false),
      );
    }
  }, []);

  return (
    <Tooltip open={isTruncated ? undefined : false}>
      <TooltipTrigger
        asChild
        ref={triggerRef}
        onMouseEnter={checkTruncation}
        onFocus={checkTruncation}
      >
        {children}
      </TooltipTrigger>
      <TooltipContent>{content}</TooltipContent>
    </Tooltip>
  );
}
