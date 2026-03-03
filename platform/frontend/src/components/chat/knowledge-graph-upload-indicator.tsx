"use client";

import { DatabaseIcon } from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

interface KnowledgeGraphUploadIndicatorProps {
  /** Number of files attached */
  attachmentCount: number;
  /** Whether the current agent has a knowledge graph assigned */
  hasKnowledgeGraph: boolean;
}

/**
 * Shows a small indicator when files are attached and the agent has a knowledge graph assigned.
 * Displays a database icon with short text, and a tooltip with more details on hover.
 */
export function KnowledgeGraphUploadIndicator({
  attachmentCount,
  hasKnowledgeGraph,
}: KnowledgeGraphUploadIndicatorProps) {
  // Don't show if no knowledge graph is assigned or no files are attached
  if (!hasKnowledgeGraph || attachmentCount === 0) {
    return null;
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div className="flex items-center gap-1.5 rounded-md bg-muted/50 px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground cursor-help">
          <DatabaseIcon className="size-3.5" />
          <span>KG Upload</span>
        </div>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-xs">
        <p>
          {attachmentCount === 1
            ? "This file will be ingested into the Knowledge Graph for enhanced search and retrieval."
            : `These ${attachmentCount} files will be ingested into the Knowledge Graph for enhanced search and retrieval.`}
        </p>
      </TooltipContent>
    </Tooltip>
  );
}
