"use client";

import { ShieldAlert } from "lucide-react";
import {
  Tool,
  ToolContent,
  ToolHeader,
  ToolInput,
} from "@/components/ai-elements/tool";
import { parseReviewPresentation } from "@/components/chat/openappa-review-presentation";
import { Button } from "@/components/ui/button";
import { InlineNotice, InlineNoticeText } from "@/components/ui/inline-notice";
import {
  useAgentRunOpenappaReview,
  useDecideAgentRunOpenappaReview,
} from "@/lib/agent-runtime.query";

export function AgentRunOpenappaReview({ taskId }: { taskId: string }) {
  const review = useAgentRunOpenappaReview(taskId);
  const decide = useDecideAgentRunOpenappaReview(taskId);
  const pending = review.data;
  if (!pending || pending.status === "none") return null;

  if (pending.status === "no_reviewer" || !pending.canDecide) {
    return (
      <InlineNotice variant="warning">
        <ShieldAlert />
        <span className="font-medium">
          {pending.status === "no_reviewer" ? (
            <span>No reviewer</span>
          ) : (
            <span>Waiting for approval</span>
          )}
        </span>
        <InlineNoticeText>
          {pending.status === "no_reviewer" ? (
            <span>
              This run needs a person's approval, but it is not acting as a
              signed-in user. The action stays blocked.
            </span>
          ) : (
            <span>
              This run is waiting for its owner to approve or deny a blocked
              action.
            </span>
          )}
        </InlineNoticeText>
      </InlineNotice>
    );
  }

  const presentation = parseReviewPresentation({
    message: pending.text ?? "",
    ...(pending.tool ? { reviewedTool: pending.tool } : {}),
    ...(pending.arguments ? { reviewedArguments: pending.arguments } : {}),
  });
  const toolType = `tool-${presentation.tool ?? "call"}` as const;
  const submit = (decision: "approve" | "deny") => {
    if (!pending.offerId) return;
    decide.mutate({ decision, offerId: pending.offerId });
  };

  return (
    <section className="flex shrink-0 flex-col gap-3 rounded-md border bg-muted/20 px-3 py-3">
      <div className="flex items-center gap-2 text-sm font-medium">
        <ShieldAlert className="size-4" />
        <span>Approval required</span>
      </div>
      {presentation.intro ? (
        <p className="whitespace-pre-wrap text-sm leading-6 [overflow-wrap:anywhere]">
          {presentation.intro}
        </p>
      ) : null}
      {presentation.tool || presentation.arguments !== undefined ? (
        <Tool defaultOpen className="mb-0">
          <ToolHeader
            type={toolType}
            state="approval-requested"
            title={presentation.tool}
            isCollapsible={false}
            statusLabel="Needs review"
          />
          {presentation.arguments !== undefined ? (
            <ToolContent>
              <ToolInput input={presentation.arguments} />
            </ToolContent>
          ) : null}
        </Tool>
      ) : (
        <p className="whitespace-pre-wrap text-sm leading-6 [overflow-wrap:anywhere]">
          {pending.text}
        </p>
      )}
      {presentation.rest ? (
        <p className="whitespace-pre-wrap text-sm leading-6 text-muted-foreground [overflow-wrap:anywhere]">
          {presentation.rest}
        </p>
      ) : null}
      <div className="flex items-center gap-2">
        <Button
          type="button"
          size="sm"
          disabled={decide.isPending || !pending.offerId}
          onClick={() => submit("approve")}
        >
          <span>{decide.isPending ? "Saving…" : "Approve"}</span>
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={decide.isPending || !pending.offerId}
          onClick={() => submit("deny")}
        >
          <span>Deny</span>
        </Button>
      </div>
    </section>
  );
}
