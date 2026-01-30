"use client";

import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

interface ExpandableTextProps {
  text: string;
  maxLines?: number;
  className?: string;
}

export function ExpandableText({
  text,
  maxLines = 2,
  className,
}: ExpandableTextProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const [isTruncated, setIsTruncated] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const measureRef = useRef<HTMLParagraphElement>(null);
  const clampedRef = useRef<HTMLParagraphElement>(null);

  // Check truncation by comparing heights (only when collapsed)
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentionally re-run when text/maxLines props change
  useEffect(() => {
    // Skip truncation check when expanded - both elements have same height when expanded
    if (isExpanded) return;

    const checkTruncation = () => {
      const measureEl = measureRef.current;
      const clampedEl = clampedRef.current;
      if (!measureEl || !clampedEl) return;

      // Compare unclamped height to clamped height
      const fullHeight = measureEl.offsetHeight;
      const clampedHeight = clampedEl.offsetHeight;

      setIsTruncated(fullHeight > clampedHeight + 2); // 2px tolerance
    };

    // Small delay to ensure DOM is updated
    const timeoutId = setTimeout(checkTruncation, 0);

    // Also check on resize
    const container = containerRef.current;
    if (!container) return () => clearTimeout(timeoutId);

    const resizeObserver = new ResizeObserver(checkTruncation);
    resizeObserver.observe(container);

    return () => {
      clearTimeout(timeoutId);
      resizeObserver.disconnect();
    };
  }, [text, maxLines, isExpanded]);

  return (
    <div ref={containerRef} className={cn("relative", className)}>
      {/* Hidden element for measuring full text height */}
      <p
        ref={measureRef}
        aria-hidden="true"
        className="invisible absolute top-0 left-0 right-0 pointer-events-none break-words"
      >
        {text}
      </p>

      {/* Visible clamped text */}
      <p
        ref={clampedRef}
        className={cn("break-words", !isExpanded && `line-clamp-${maxLines}`)}
        style={
          !isExpanded
            ? {
                display: "-webkit-box",
                WebkitLineClamp: maxLines,
                WebkitBoxOrient: "vertical",
                overflow: "hidden",
              }
            : undefined
        }
      >
        {text}
      </p>

      {isTruncated && (
        <button
          type="button"
          onClick={() => setIsExpanded(!isExpanded)}
          className="text-primary hover:underline text-inherit mt-1"
        >
          {isExpanded ? "Show less" : "Show more"}
        </button>
      )}
    </div>
  );
}
