"use client";

import { BellOff } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { STATUS_TONE } from "@/lib/design/status-tone";
import { typeRole } from "@/lib/design/type-scale";
import {
  describeMcpServerIssue,
  getMcpServerIssueKindMeta,
  type McpServerIssue,
} from "@/lib/mcp/mcp-server-issues";
import { cn } from "@/lib/utils";

/**
 * One status pill for one issue: the vocabulary label, tinted by severity.
 * When the issue carries a cause it is exposed through a tooltip on a
 * focusable trigger, so keyboard and touch users can reach it too.
 *
 * The trigger is a focusable note, not a button: pressing it does nothing, and
 * a control announced as a button that answers no press is worse than a label.
 * Its `aria-label` carries the cause, so the text is reachable even where the
 * tooltip is not.
 *
 * The tooltip is an enhancement and never the only copy of the cause: it opens
 * on hover and on focus, which leaves a tap on a touch screen with nothing to
 * show. `McpServerIssueStatusCell` is what a list row should render.
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
      className={cn("max-w-full", STATUS_TONE[issue.severity], className)}
      data-testid={`mcp-server-issue-${issue.kind}`}
    >
      {issue.muted && <BellOff aria-hidden className="size-3" />}
      <span className="truncate">{meta.label}</span>
    </Badge>
  );
  if (!issue.detail) return badge;
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
 * The status of one server as a list cell: the severity badge to scan by, and
 * one truncated line saying what is actually wrong. Shared by the registry
 * table and the cards so a row reads the same in both.
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
  // already carries it verbatim for anyone who wants the exact text. A mute
  // carries the note the viewer gave for it, so a silenced row says why it is
  // silenced instead of only that it is.
  const mutedPrefix = issue.mutedReason
    ? `Muted by you: ${issue.mutedReason}.`
    : "Muted by you.";
  const cause = issue.muted ? `${mutedPrefix} ${what}` : what;
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
