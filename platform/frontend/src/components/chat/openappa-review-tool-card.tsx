"use client";

import { CheckCircleIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Response } from "@/components/ai-elements/response";
import { ToolInputBody } from "@/components/ai-elements/tool";
import {
  getReviewCardView,
  type ReviewDecision,
} from "@/components/chat/openappa-review-presentation";
import { CodeText } from "@/components/code-text";
import { Button } from "@/components/ui/button";
import { useArchestraMcpIdentity } from "@/lib/mcp/archestra-mcp-server";
import { cn } from "@/lib/utils/tailwind";
import { SkillApprovalInput } from "./skill-approval-input";
import { getSkillApprovalView } from "./skill-approval-presentation";

/**
 * An OpenAPPA review: a question to the person, not a tool call. It asks
 * whether the agent may run one call, shows that call's arguments and what
 * approving also accepts, and takes the answer. It reads as a question, so it
 * is not mistaken for the call's own card: the call gets one once it runs.
 */
export function OpenappaReviewToolCard({
  id,
  message,
  reviewedTool,
  reviewedArguments,
  reviewedCoverage,
  reviewedText,
  disabled,
  secondaryText,
  embedded = false,
  onDecide,
}: {
  /** Names the question for the form around it. */
  id?: string;
  message: string;
  reviewedTool?: string;
  reviewedArguments?: string;
  reviewedCoverage?: string[];
  reviewedText?: string;
  disabled?: boolean;
  secondaryText?: ReactNode;
  /** Shown inside a card of several questions, which has the frame. */
  embedded?: boolean;
  onDecide: (decision: ReviewDecision) => void;
}) {
  const { getToolShortName } = useArchestraMcpIdentity();
  const view = getReviewCardView({
    message,
    ...(reviewedTool ? { reviewedTool } : {}),
    ...(reviewedArguments ? { reviewedArguments } : {}),
    ...(reviewedCoverage ? { reviewedCoverage } : {}),
    ...(reviewedText ? { reviewedText } : {}),
  });
  const tool = view.toolCard?.title;
  const hasInput = view.toolCard?.input !== undefined;
  const skill = getSkillApprovalView(
    reviewedTool ? getToolShortName(reviewedTool) : null,
    reviewedArguments,
  );

  return (
    <div
      className={cn(
        "flex min-w-0 flex-col gap-4",
        !embedded && "rounded-lg border border-border/60 bg-card p-4 shadow-sm",
      )}
    >
      <div className="flex min-w-0 flex-col gap-1">
        <p
          id={id}
          className="text-sm font-medium leading-snug [overflow-wrap:anywhere]"
        >
          {tool ? (
            <>
              <span>Run </span>
              <CodeText className="text-xs">{tool}</CodeText>
              <span>?</span>
            </>
          ) : (
            <span>Approve this step?</span>
          )}
        </p>
        <p className="text-xs leading-relaxed text-muted-foreground">
          The agent asks to run this call. It runs only after you approve.
        </p>
      </div>
      {hasInput ? (
        skill ? (
          <SkillApprovalInput skill={skill} />
        ) : (
          <div className="flex min-w-0 flex-col gap-1.5">
            <p className="text-xs font-medium">Arguments</p>
            <ToolInputBody input={view.toolCard?.input} />
          </div>
        )
      ) : null}
      {view.coverage ? (
        <div className="space-y-2 text-xs">
          <p className="font-medium">Approving also accepts:</p>
          <ul
            aria-label="Approval consequences"
            className="list-disc space-y-2 pl-4 text-muted-foreground"
          >
            {view.coverage.map((line, index) => (
              <li
                // biome-ignore lint/suspicious/noArrayIndexKey: coverage is an immutable review snapshot and may repeat a line
                key={index}
                className="pl-1 leading-relaxed [overflow-wrap:anywhere]"
              >
                <Response preserveLineBreaks>{line}</Response>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {view.details ? (
        <p className="whitespace-pre-wrap text-xs leading-relaxed text-muted-foreground [overflow-wrap:anywhere]">
          {view.details}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center justify-end gap-3 border-t border-border/60 pt-3">
        {secondaryText ? (
          <p className="mr-auto min-w-0 text-xs text-muted-foreground [overflow-wrap:anywhere]">
            {secondaryText}
          </p>
        ) : null}
        <div className="flex shrink-0 items-center gap-2">
          <Button
            type="button"
            size="sm"
            variant="secondary"
            disabled={disabled}
            onClick={() => onDecide("approve")}
          >
            <CheckCircleIcon className="size-4" />
            <span>Approve</span>
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={disabled}
            onClick={() => onDecide("deny")}
          >
            Deny
          </Button>
        </div>
      </div>
    </div>
  );
}
