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
  const positionLabel =
    position === 0
      ? "Queued (next)"
      : position !== undefined && position > 0
        ? `Queued #${position + 1}`
        : "Queued";

  return (
    <div
      className={cn(
        "flex items-center gap-3 rounded-lg border bg-muted/50 p-3 shadow-sm transition-all",
        className,
      )}
    >
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-1">
          <span className="text-xs font-medium text-muted-foreground">
            {positionLabel}
          </span>
        </div>
        <p className="text-sm text-foreground line-clamp-2 break-words">
          {message}
        </p>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onDelete}
          className="h-8 w-8 text-muted-foreground hover:text-destructive"
          aria-label="Delete queued message"
        >
          <X className="h-4 w-4" />
        </Button>
        <Button
          variant="default"
          size="icon-sm"
          onClick={onSendNow}
          className="h-8 w-8"
          aria-label="Send message now"
        >
          <Send className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}
