"use client";

import { Send, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface QueuedMessageProps {
  message: string;
  onDelete: () => void;
  onSendNow: () => void;
  position?: number;
  className?: string;
}

export function QueuedMessage({
  message,
  onDelete,
  onSendNow,
  position,
  className,
}: QueuedMessageProps) {
  return (
    <div
      className={cn(
        "flex items-center gap-2 rounded-md border bg-muted/50 p-1.5 shadow-sm transition-all group",
        className,
      )}
    >
      <div className="flex-1 min-w-0 flex items-baseline gap-2">
        <span className="text-[10px] uppercase tracking-wider font-bold text-muted-foreground/70 whitespace-nowrap shrink-0">
          {position === 0 ? "Next" : `#${(position || 0) + 1}`}
        </span>
        <p className="text-xs text-foreground line-clamp-1 break-word leading-tight">
          {message}
        </p>
      </div>
      <div className="flex items-center gap-0.5 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onDelete}
          className="h-5 w-5 text-muted-foreground hover:text-destructive"
          aria-label="Delete queued message"
        >
          <X className="h-3 w-3" />
        </Button>
        <Button
          variant="default"
          size="icon-sm"
          onClick={onSendNow}
          className="h-5 w-5"
          aria-label="Send message now"
        >
          <Send className="h-3 w-3" />
        </Button>
      </div>
    </div>
  );
}
