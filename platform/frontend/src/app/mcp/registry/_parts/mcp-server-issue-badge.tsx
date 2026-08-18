"use client";

import { Badge } from "@/components/ui/badge";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  getMcpServerIssueKindMeta,
  type McpServerIssue,
  type McpServerIssueSeverity,
} from "@/lib/mcp/mcp-server-issues";
import { cn } from "@/lib/utils";

// Same recipe as the knowledge connectors' status badge, so status reads the
// same across the product: tinted fill, matching border, dark-mode-aware text.
const SEVERITY_CLASS: Record<McpServerIssueSeverity, string> = {
  down: "border border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-400",
  attention:
    "border border-amber-500/30 bg-amber-500/10 text-amber-800 dark:text-amber-400",
  progress: "border border-border bg-muted text-muted-foreground",
};

/**
 * One status pill for one issue: the vocabulary label, tinted by severity.
 * When the issue carries a cause it is exposed through a tooltip on a
 * focusable trigger, so keyboard and touch users can reach it too.
 */
export function McpServerIssueBadge({
  issue,
  className,
}: {
  issue: McpServerIssue;
  className?: string;
}) {
  const meta = getMcpServerIssueKindMeta(issue.kind);
  const badge = (
    <Badge
      variant="secondary"
      className={cn("max-w-full", SEVERITY_CLASS[issue.severity], className)}
      data-testid={`mcp-server-issue-${issue.kind}`}
    >
      <span className="truncate">{meta.label}</span>
    </Badge>
  );
  if (!issue.detail) return badge;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          className="max-w-full rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label={`${meta.label}: ${issue.detail}`}
        >
          {badge}
        </button>
      </TooltipTrigger>
      <TooltipContent className="max-w-sm break-words">
        {issue.detail}
      </TooltipContent>
    </Tooltip>
  );
}
