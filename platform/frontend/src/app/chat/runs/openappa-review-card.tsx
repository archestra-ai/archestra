"use client";

import { ShieldAlert } from "lucide-react";
import type { ReviewDecision } from "@/components/chat/openappa-review-presentation";
import { OpenappaReviewToolCard } from "@/components/chat/openappa-review-tool-card";
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

  const submit = (decision: ReviewDecision) => {
    if (!pending.offerId) return;
    decide.mutate({ decision, offerId: pending.offerId });
  };

  return (
    <section className="flex shrink-0 flex-col">
      <OpenappaReviewToolCard
        message={pending.text ?? ""}
        reviewedTool={pending.tool ?? undefined}
        reviewedArguments={pending.arguments ?? undefined}
        disabled={decide.isPending || !pending.offerId}
        secondaryText={
          decide.isPending ? <span>Saving decision...</span> : undefined
        }
        onDecide={submit}
      />
    </section>
  );
}
