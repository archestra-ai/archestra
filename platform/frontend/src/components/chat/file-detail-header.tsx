"use client";

import { ChevronLeft, Maximize2 } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";

/**
 * Header for an open file in the Files panels. In the default split view it
 * shows the name + an Expand (⤢) button that fills the panel; once expanded it
 * shows a "‹ Files" button that collapses back to the split (the file stays
 * selected). `children` are the right-aligned per-file actions (download/delete,
 * or the artifact's copy/PDF). Shared so the chat and project panels match.
 */
export function FileDetailHeader({
  title,
  expanded,
  onExpand,
  onCollapse,
  children,
}: {
  title: string;
  expanded: boolean;
  onExpand: () => void;
  onCollapse: () => void;
  children?: ReactNode;
}) {
  return (
    <div className="flex shrink-0 items-center gap-1 border-b px-4 py-1.5">
      {expanded && (
        <Button
          variant="ghost"
          size="xs"
          className="-ml-2 shrink-0 text-muted-foreground"
          onClick={onCollapse}
        >
          <ChevronLeft className="h-4 w-4" />
          Files
        </Button>
      )}
      <span
        className="min-w-0 flex-1 truncate text-sm font-medium"
        title={title}
      >
        {title}
      </span>
      {!expanded && (
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          onClick={onExpand}
          title="Expand to full panel"
          className="text-muted-foreground"
        >
          <Maximize2 className="h-4 w-4" />
          <span className="sr-only">Expand to full panel</span>
        </Button>
      )}
      {children}
    </div>
  );
}
