"use client";

import { Clock } from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { UnstyledButton } from "@/components/ui/unstyled-button";
import { formatCompactRelativeTime, formatDate } from "@/lib/utils/date-time";

export function LogTime({
  timestamp,
  durationMs,
  span,
  showTooltip = true,
}: {
  timestamp: string | Date;
  durationMs?: number | null;
  span?: string | null;
  showTooltip?: boolean;
}) {
  const date =
    typeof timestamp === "string" ? timestamp : timestamp.toISOString();
  const age = formatCompactRelativeTime(timestamp);
  const duration =
    durationMs == null
      ? (span ?? null)
      : durationMs < 1000
        ? `${durationMs}ms`
        : `${(durationMs / 1000).toFixed(2).replace(/0$/, "").replace(/\.0$/, "")}s`;
  const label = durationMs == null ? "Session span" : "Request duration";
  const className =
    "w-fit max-w-[154px] whitespace-nowrap text-left text-xs leading-4 tabular-nums";
  const content = (
    <>
      <span className="flex items-center gap-1.5">
        <span>{age}</span>
        {duration !== null && (
          <span
            className="inline-flex items-center gap-0.5 text-[11px] text-muted-foreground"
            role="img"
            aria-label={`${label}: ${duration}`}
          >
            <Clock className="size-2.5" aria-hidden="true" />
            <span>{duration}</span>
          </span>
        )}
      </span>
      <span className="block text-[11px] text-muted-foreground">
        {formatDate({ date, dateFormat: "MMM d · HH:mm" })}
      </span>
    </>
  );
  if (!showTooltip)
    return (
      <time dateTime={date} className={className}>
        {content}
      </time>
    );
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <UnstyledButton
          onClick={(event) => event.stopPropagation()}
          className={`${className} cursor-default`}
        >
          {content}
        </UnstyledButton>
      </TooltipTrigger>
      <TooltipContent className="px-2 py-1 text-xs">
        <div>{formatDate({ date })}</div>
        {duration !== null && (
          <div className="text-muted-foreground">
            {label}: {duration}
          </div>
        )}
      </TooltipContent>
    </Tooltip>
  );
}
