"use client";

import { CheckCircleIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Response } from "@/components/ai-elements/response";
import {
  Tool,
  ToolContent,
  ToolHeader,
  ToolInput,
} from "@/components/ai-elements/tool";
import {
  getReviewCardView,
  type ReviewDecision,
} from "@/components/chat/openappa-review-presentation";
import { Button } from "@/components/ui/button";

/**
 * An OpenAPPA review shown like Chat's tool approval: the reviewed tool's
 * card (arguments initially expanded) with an always-visible Approve/Deny row.
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
  onDecide,
}: {
  id?: string;
  message: string;
  reviewedTool?: string;
  reviewedArguments?: string;
  reviewedCoverage?: string[];
  reviewedText?: string;
  disabled?: boolean;
  secondaryText?: ReactNode;
  onDecide: (decision: ReviewDecision) => void;
}) {
  const view = getReviewCardView({
    message,
    ...(reviewedTool ? { reviewedTool } : {}),
    ...(reviewedArguments ? { reviewedArguments } : {}),
    ...(reviewedCoverage ? { reviewedCoverage } : {}),
    ...(reviewedText ? { reviewedText } : {}),
  });
  const hasInput = view.toolCard?.input !== undefined;

  return (
    <Tool id={id} defaultOpen={hasInput} className="mb-0">
      {view.toolCard ? (
        <ToolHeader
          type={`tool-${view.toolCard.title ?? "call"}`}
          title={view.toolCard.title}
          state="approval-requested"
          isCollapsible={hasInput}
        />
      ) : null}
      {hasInput ? (
        <ToolContent>
          <ToolInput input={view.toolCard?.input} />
        </ToolContent>
      ) : null}
      <div className="space-y-3 p-3">
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
    </Tool>
  );
}
