"use client";

import { formatDistanceToNow } from "date-fns";
import { Clock } from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { formatDate } from "@/lib/utils/date-time";

/**
 * The one way this app says "happened X ago": a relative, never-wrapping
 * phrase with the exact local timestamp on hover.
 *
 * Tables had been open-coding the pair (`formatDistanceToNow` + a `title` with
 * `formatDate`) column by column, which is how the same idea ended up spelled
 * as a bare relative phrase in one table and a full `MM/dd/yyyy HH:mm:ss`
 * stamp in the next. A column that needs the absolute time to be *readable*
 * rather than merely reachable — an audit log — still formats it itself; this
 * is for the "when did this last happen" cells, which is most of them.
 */
export function RelativeTime({
  date,
  showIcon = false,
  emptyLabel = "-",
  className,
}: {
  date: string | Date | null | undefined;
  /** Prefix with a clock glyph, for cells that carry nothing else. */
  showIcon?: boolean;
  /** Rendered instead when there is no date (never synced, still running). */
  emptyLabel?: string;
  className?: string;
}) {
  if (!date) {
    return (
      <span className={cn("text-sm text-muted-foreground", className)}>
        {emptyLabel}
      </span>
    );
  }

  const parsed = typeof date === "string" ? new Date(date) : date;
  if (Number.isNaN(parsed.getTime())) {
    return (
      <span className={cn("text-sm text-muted-foreground", className)}>
        {emptyLabel}
      </span>
    );
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className={cn(
            "inline-flex cursor-default items-center gap-1.5 whitespace-nowrap text-sm text-muted-foreground",
            className,
          )}
        >
          {showIcon && <Clock className="h-3.5 w-3.5 shrink-0" />}
          {formatDistanceToNow(parsed, { addSuffix: true })}
        </span>
      </TooltipTrigger>
      <TooltipContent className="font-mono">
        {formatDate({ date: parsed.toISOString() })}
      </TooltipContent>
    </Tooltip>
  );
}
