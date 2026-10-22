"use client";

import { CheckCircleIcon, ClockIcon } from "lucide-react";
import type { ReactNode } from "react";
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
import { ToolStatusRow } from "@/components/chat/tool-status-row";

/**
 * An OpenAPPA review shown like Chat's tool approval: the reviewed tool's
 * card (arguments collapsed) with an always-visible Approve/Deny row.
 */
export function OpenappaReviewToolCard({
  id,
  message,
  reviewedTool,
  reviewedArguments,
  disabled,
  secondaryText,
  onDecide,
}: {
  id?: string;
  message: string;
  reviewedTool?: string;
  reviewedArguments?: string;
  disabled?: boolean;
  secondaryText?: ReactNode;
  onDecide: (decision: ReviewDecision) => void;
}) {
  const view = getReviewCardView({
    message,
    ...(reviewedTool ? { reviewedTool } : {}),
    ...(reviewedArguments ? { reviewedArguments } : {}),
  });
  const hasInput = view.toolCard?.input !== undefined;

  return (
    <Tool
      id={id}
      defaultOpen={false}
      className={hasInput ? "mb-0 cursor-pointer" : "mb-0"}
    >
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
      <ToolStatusRow
        icon={<ClockIcon className="size-4 text-amber-600" />}
        title="Approval required"
        description={
          <span className="whitespace-pre-wrap [overflow-wrap:anywhere]">
            {view.description}
          </span>
        }
        secondaryText={secondaryText}
        actions={[
          {
            label: "Approve",
            variant: "secondary",
            icon: <CheckCircleIcon className="size-4" />,
            disabled,
            onClick: () => onDecide("approve"),
          },
          {
            label: "Deny",
            variant: "outline",
            disabled,
            onClick: () => onDecide("deny"),
          },
        ]}
      />
    </Tool>
  );
}
