"use client";

import { BellOff } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { typeRole } from "@/lib/design/type-scale";
import {
  describeMcpServerIssue,
  getMcpServerIssueKindMeta,
  type McpServerIssue,
} from "@/lib/mcp/mcp-server-issues";
import { cn } from "@/lib/utils";

const ISSUE_TONE: Record<McpServerIssue["kind"], string> = {
  "failed-to-start":
    "border border-red-500/15 bg-red-500/5 text-red-800/80 dark:text-red-300/85",
  "not-running":
    "border border-red-500/15 bg-red-500/5 text-red-800/80 dark:text-red-300/85",
  "needs-reauth":
    "border border-orange-500/15 bg-orange-500/5 text-orange-900/80 dark:text-orange-300/85",
};

/**
 * One status pill for one issue: the vocabulary label, tinted by the kind of
 * attention it needs. Runtime failures use red; re-authentication uses orange,
 * the familiar action-needed warning color, kept distinct from the blue, green,
 * amber, and purple scope colors in the neighboring visibility column. When the
 * issue carries a cause it is exposed through a tooltip on a focusable trigger,
 * so keyboard and touch users can reach it too.
 *
 * The trigger is a focusable note, not a button: pressing it does nothing, and
 * a control announced as a button that answers no press is worse than a label.
 * Its `aria-label` carries the cause, so the text is reachable even where the
 * tooltip is not.
 *
 * Compact scanning surfaces pass `showDetail={false}` and render only the
 * status. Surfaces that also need a visible diagnosis use
 * `McpServerIssueStatusCell`.
 */
export function McpServerIssueBadge({
  issue,
  className,
  showDetail = true,
}: {
  issue: McpServerIssue;
  className?: string;
  /** Keep raw runtime/provider detail out of summary-only badges. */
  showDetail?: boolean;
}) {
  const meta = getMcpServerIssueKindMeta(issue.kind);
  const badge = (
    <Badge
      variant="secondary"
      className={cn(
        "max-w-full",
        !issue.muted && ISSUE_TONE[issue.kind],
        className,
      )}
      data-testid={`mcp-server-issue-${issue.kind}`}
    >
      {issue.muted && <BellOff aria-hidden className="size-3" />}
      <span className="truncate">{meta.label}</span>
    </Badge>
  );
  if (!showDetail || !issue.detail) return badge;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {/* Named, not focusable: the detail is in the accessible name, and the
            status cell prints the same cause visibly beside the pill, so
            nothing here is reachable only by hovering. A tabIndex would put a
            non-interactive node in the tab order to no end. */}
        <span
          role="note"
          className="max-w-full"
          aria-label={`${meta.label}: ${issue.detail}`}
        >
          {badge}
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-sm break-words">
        {issue.detail}
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * The status of one server as a list cell: the badge to scan by, and one
 * truncated line saying what is actually wrong. Used where the status is also
 * a diagnosis; the registry table deliberately stays badge-only.
 *
 * The line is body copy, not `meta`: it is the sentence that decides whether
 * the reader opens the server at all, and a status nobody can read without
 * hovering is a status nobody reads.
 */
export function McpServerIssueStatusCell({
  issue,
  className,
}: {
  issue: McpServerIssue;
  className?: string;
}) {
  const { what } = describeMcpServerIssue(issue);
  // The plain-English condition rather than the raw provider message: that
  // message is an OAuth error code or a kubelet line, and the badge's tooltip
  // already carries it verbatim for anyone who wants the exact text. A
  // dismissal carries the viewer's note so the badge can say why it left the
  // queue, not merely that it did.
  const dismissedPrefix = issue.mutedReason
    ? `Dismissed by you: ${issue.mutedReason}.`
    : "Dismissed by you.";
  const cause = issue.muted ? `${dismissedPrefix} ${what}` : what;
  return (
    <div className={cn("flex min-w-0 flex-col gap-1", className)}>
      <McpServerIssueBadge issue={issue} className="w-fit" />
      {cause && (
        <span
          className={cn(typeRole({ role: "body" }), "truncate")}
          title={cause}
        >
          {cause}
        </span>
      )}
    </div>
  );
}
