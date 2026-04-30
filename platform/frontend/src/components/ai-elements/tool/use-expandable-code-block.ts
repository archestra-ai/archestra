"use client";

import { useRef, useState } from "react";

const MAX_LINES = 20;

export function useExpandableCodeBlock(code: string) {
  const [isExpanded, setIsExpanded] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const lines = code.split("\n");
  const isLarge = lines.length > MAX_LINES;
  const remainingLines = Math.max(lines.length - MAX_LINES, 0);
  const displayCode =
    isExpanded || !isLarge
      ? code
      : `${lines.slice(0, MAX_LINES).join("\n")}\n... (${remainingLines} more lines)`;

  const toggleExpanded = () => {
    const el = containerRef.current;
    const scrollTop = el ? el.getBoundingClientRect().top : undefined;

    setIsExpanded((current) => !current);

    if (el && scrollTop !== undefined) {
      requestAnimationFrame(() => {
        const newTop = el.getBoundingClientRect().top;
        window.scrollBy(0, newTop - scrollTop);
      });
    }
  };

  return {
    containerRef,
    displayCode,
    isExpanded,
    isLarge,
    remainingLines,
    toggleExpanded,
  };
}
