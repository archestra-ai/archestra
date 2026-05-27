"use client";

import { DatabaseIcon } from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

interface KnowledgeBaseUploadIndicatorProps {
  /** Number of files attached */
  attachmentCount: number;
}

/**
 * Shows a small indicator when files are attached in chat.
 */
export function KnowledgeBaseUploadIndicator({
  attachmentCount,
}: KnowledgeBaseUploadIndicatorProps) {
  if (attachmentCount === 0) {
    return null;
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div className="flex items-center gap-1.5 rounded-md bg-muted/50 px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground cursor-help">
          <DatabaseIcon className="size-3.5" />
          <span>Chat attachment</span>
        </div>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-xs">
        <p>
          Chat attachments stay with this conversation. Upload reusable files
          from Knowledge &gt; Files.
        </p>
      </TooltipContent>
    </Tooltip>
  );
}
