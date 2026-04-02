"use client";

import { TriangleAlert } from "lucide-react";
import type { Ref } from "react";
import { cn } from "@/lib/utils";

export function MessageBoundaryDivider({
  label,
  tone = "neutral",
  dividerRef,
}: {
  label: string;
  tone?: "neutral" | "warning";
  dividerRef?: Ref<HTMLDivElement>;
}) {
  const isWarning = tone === "warning";

  return (
    <div ref={dividerRef} className="flex items-center gap-3 py-2">
      <div
        className={cn("h-px flex-1 bg-border", isWarning && "bg-orange-600")}
      />
      <span
        className={cn(
          "inline-flex items-center gap-1.5 text-xs text-muted-foreground",
          isWarning && "text-orange-600",
        )}
      >
        {isWarning && <TriangleAlert className="size-3.5" />}
        {label}
        {isWarning && <TriangleAlert className="size-3.5" />}
      </span>
      <div
        className={cn("h-px flex-1 bg-border", isWarning && "bg-orange-600")}
      />
    </div>
  );
}

export function SensitiveContextStickyIndicator({
  visible,
}: {
  visible: boolean;
}) {
  if (!visible) {
    return null;
  }

  return (
    <div className="sticky top-2 z-20 flex justify-center px-4 pb-2 pointer-events-none">
      <div className="inline-flex items-center gap-1.5 rounded-full border border-orange-600/50 bg-background/95 px-3 py-1 text-xs text-orange-600 shadow-sm backdrop-blur-sm">
        <TriangleAlert className="size-3.5" />
        Sensitive context detected
      </div>
    </div>
  );
}

export function PreexistingUnsafeContextDivider({
  dividerRef,
}: {
  dividerRef?: Ref<HTMLDivElement>;
}) {
  return (
    <MessageBoundaryDivider
      label="Sensitive context below"
      tone="warning"
      dividerRef={dividerRef}
    />
  );
}

export function UnsafeContextStartsHereDivider({
  dividerRef,
}: {
  dividerRef?: Ref<HTMLDivElement>;
}) {
  return (
    <MessageBoundaryDivider
      label="Sensitive context below"
      tone="warning"
      dividerRef={dividerRef}
    />
  );
}

export function shouldShowStickyBoundaryIndicator(params: {
  boundaryTop: number;
  boundaryBottom: number;
  containerTop: number;
}): boolean {
  return (
    params.boundaryTop < params.containerTop &&
    params.boundaryBottom < params.containerTop + 24
  );
}

export function findScrollContainer(element: HTMLElement): HTMLElement | null {
  let current: HTMLElement | null = element.parentElement;

  while (current) {
    const { overflowY } = window.getComputedStyle(current);
    if (overflowY === "auto" || overflowY === "scroll") {
      return current;
    }
    current = current.parentElement;
  }

  return null;
}
