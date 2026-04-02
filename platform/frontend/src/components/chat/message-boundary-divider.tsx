"use client";

import { TriangleAlert } from "lucide-react";
import { cn } from "@/lib/utils";

export function MessageBoundaryDivider({
  label,
  tone = "neutral",
}: {
  label: string;
  tone?: "neutral" | "warning";
}) {
  const isWarning = tone === "warning";

  return (
    <div className="flex items-center gap-3 py-2">
      <div
        className={cn("h-px flex-1 bg-border", isWarning && "bg-amber-300")}
      />
      <span
        className={cn(
          "inline-flex items-center gap-1.5 text-xs text-muted-foreground",
          isWarning && "text-amber-700",
        )}
      >
        {isWarning && <TriangleAlert className="size-3.5" />}
        {label}
        {isWarning && <TriangleAlert className="size-3.5" />}
      </span>
      <div
        className={cn("h-px flex-1 bg-border", isWarning && "bg-amber-300")}
      />
    </div>
  );
}

export function PreexistingUnsafeContextDivider() {
  return (
    <MessageBoundaryDivider
      label="Sensitive context was already active when this request started"
      tone="warning"
    />
  );
}

export function UnsafeContextStartsHereDivider() {
  return (
    <MessageBoundaryDivider
      label="Sensitive context starts here"
      tone="warning"
    />
  );
}
