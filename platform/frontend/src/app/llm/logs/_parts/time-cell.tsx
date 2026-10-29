"use client";

import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { UnstyledButton } from "@/components/ui/unstyled-button";
import { formatCompactRelativeTime, formatDate } from "@/lib/utils/date-time";
import { formatSessionSpan, type LogSession } from "./logs-table-format";

/** How long ago the last request was, then the request count and span. */
export function TimeCell({
  session,
}: {
  session: Pick<
    LogSession,
    "firstRequestTime" | "lastRequestTime" | "requestCount" | "failedOverCount"
  >;
}) {
  const { firstRequestTime, lastRequestTime, requestCount, failedOverCount } =
    session;
  if (!lastRequestTime) {
    return <div className="text-right text-xs text-muted-foreground">—</div>;
  }
  const span =
    requestCount > 1 && firstRequestTime
      ? formatSessionSpan(firstRequestTime, lastRequestTime)
      : null;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <UnstyledButton className="ml-auto block cursor-default text-right tabular-nums">
          <time dateTime={lastRequestTime} className="block text-sm leading-5">
            {formatCompactRelativeTime(lastRequestTime)}
          </time>
          <span className="block text-xs leading-4 whitespace-nowrap text-muted-foreground">
            <span>{requestCount.toLocaleString()} req</span>
            {span ? <span> · {span}</span> : null}
          </span>
          {/* Its own line: beside the count and span it overflows the column. */}
          {failedOverCount > 0 ? (
            <span className="block text-xs leading-4 whitespace-nowrap text-red-700 dark:text-red-400">
              {failedOverCount.toLocaleString()} failed over
            </span>
          ) : null}
        </UnstyledButton>
      </TooltipTrigger>
      <TooltipContent className="px-2 py-1.5">
        <dl className="grid grid-cols-[auto_auto] gap-x-4 gap-y-0.5 tabular-nums">
          <dt className="text-muted-foreground">Last request</dt>
          <dd className="text-right">
            {formatDate({ date: lastRequestTime })}
          </dd>
          {span && firstRequestTime ? (
            <>
              <dt className="text-muted-foreground">First request</dt>
              <dd className="text-right">
                {formatDate({ date: firstRequestTime })}
              </dd>
              <dt className="text-muted-foreground">Span</dt>
              <dd className="text-right">{span}</dd>
            </>
          ) : null}
        </dl>
      </TooltipContent>
    </Tooltip>
  );
}
