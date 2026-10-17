"use client";

import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { UnstyledButton } from "@/components/ui/unstyled-button";
import { formatCompactRelativeTime, formatDate } from "@/lib/utils/date-time";
import type { McpToolCallRow } from "./types";

/** How long the call took, over the MCP method it used. */
export function DurationCell({ row }: { row: McpToolCallRow }) {
  return (
    <div className="text-right whitespace-nowrap tabular-nums">
      <div className="text-sm leading-5 font-medium">
        {row.durationMs == null ? "—" : formatDuration(row.durationMs)}
      </div>
      <div className="font-mono text-[11px] leading-4 text-muted-foreground">
        {row.method || "tools/call"}
      </div>
    </div>
  );
}

/** How long ago the call was made, over its clock time. */
export function CalledAtCell({ row }: { row: McpToolCallRow }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <UnstyledButton className="ml-auto block cursor-default text-right tabular-nums">
          <time dateTime={row.createdAt} className="block text-sm leading-5">
            {formatCompactRelativeTime(row.createdAt)}
          </time>
          <span className="block text-xs leading-4 whitespace-nowrap text-muted-foreground">
            {formatDate({ date: row.createdAt, dateFormat: "MMM d · HH:mm" })}
          </span>
        </UnstyledButton>
      </TooltipTrigger>
      <TooltipContent className="px-2 py-1.5">
        <dl className="grid grid-cols-[auto_auto] gap-x-4 gap-y-0.5 tabular-nums">
          <dt className="text-muted-foreground">Called</dt>
          <dd className="text-right">{formatDate({ date: row.createdAt })}</dd>
          {row.durationMs != null ? (
            <>
              <dt className="text-muted-foreground">Duration</dt>
              <dd className="text-right">
                {row.durationMs.toLocaleString()} ms
              </dd>
            </>
          ) : null}
          <dt className="text-muted-foreground">Source</dt>
          <dd className="text-right">
            {row.source === "chat" ? "Chat" : "API"}
          </dd>
        </dl>
      </TooltipContent>
    </Tooltip>
  );
}

// ============================================================================
// Internal helpers
// ============================================================================

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)}s`;
  const minutes = Math.floor(ms / 60_000);
  return `${minutes}m ${Math.round((ms % 60_000) / 1000)}s`;
}
