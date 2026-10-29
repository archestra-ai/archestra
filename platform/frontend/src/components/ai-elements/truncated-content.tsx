"use client";

import { type ReactNode, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils/tailwind";

/** Lines a tool card shows before "Show N more lines". */
export const TRUNCATED_CONTENT_MAX_LINES = 20;

/**
 * Collapses long content to `maxLines` with a "Show N more lines" button over
 * a gradient fade, keeping the content where it was on screen when it opens
 * or closes. `children` renders the content for the current state.
 */
export function TruncatedContent({
  lineCount,
  maxLines = TRUNCATED_CONTENT_MAX_LINES,
  children,
}: {
  lineCount: number;
  maxLines?: number;
  children: (isExpanded: boolean) => ReactNode;
}) {
  const [isExpanded, setIsExpanded] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const isLarge = lineCount > maxLines;

  return (
    <div ref={containerRef} className="relative group">
      {children(isExpanded || !isLarge)}
      {isLarge && (
        <div
          className={cn(
            "absolute bottom-1 left-0 right-0 flex justify-center transition-all duration-200",
            !isExpanded &&
              "pt-12 pb-1 bg-gradient-to-t from-background/80 to-transparent",
          )}
        >
          <Button
            variant="secondary"
            size="xs"
            aria-expanded={isExpanded}
            onClick={(e) => {
              e.stopPropagation();
              const el = containerRef.current;
              const scrollTop = el ? el.getBoundingClientRect().top : undefined;
              setIsExpanded(!isExpanded);
              if (el && scrollTop !== undefined) {
                requestAnimationFrame(() => {
                  const newTop = el.getBoundingClientRect().top;
                  window.scrollBy(0, newTop - scrollTop);
                });
              }
            }}
            className="shadow-sm bg-background/80 backdrop-blur-sm hover:bg-background border"
          >
            {isExpanded
              ? "Show Less"
              : `Show ${lineCount - maxLines} more lines`}
          </Button>
        </div>
      )}
    </div>
  );
}
