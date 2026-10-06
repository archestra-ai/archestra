"use client";

import { ShieldAlert } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { PageLayout } from "@/components/page-layout";
import { Button } from "@/components/ui/button";
import { InlineNotice, InlineNoticeText } from "@/components/ui/inline-notice";
import { usePageTitle } from "@/lib/hooks/use-page-title";
import {
  useOpenappaReview,
  useSubmitOpenappaReview,
} from "@/lib/openappa-review.query";

export default function OpenappaReviewPage() {
  usePageTitle("Review required");
  const searchParams = useSearchParams();
  const taskId = searchParams.get("task");
  const approvalId = searchParams.get("approval");
  const review = useOpenappaReview({ taskId, approvalId });
  const submit = useSubmitOpenappaReview();
  const currentDecision =
    submit.variables?.taskId === taskId &&
    submit.variables?.approvalId === approvalId;

  return (
    <PageLayout title="Review required">
      {!taskId || !approvalId ? (
        <InlineNotice variant="error">
          <ShieldAlert />
          <span className="font-medium">Missing review</span>
          <InlineNoticeText>
            <span>This link does not identify a review.</span>
          </InlineNoticeText>
        </InlineNotice>
      ) : currentDecision && submit.isSuccess ? (
        <InlineNotice variant="success">
          <span className="font-medium">Decision recorded</span>
          <InlineNoticeText>
            <span>
              The result is sent to the original conversation if guardrails
              allow it.
            </span>
          </InlineNoticeText>
        </InlineNotice>
      ) : review.isLoading ? (
        <span>Loading review…</span>
      ) : review.isError || !review.data ? (
        <InlineNotice variant="error">
          <ShieldAlert />
          <span className="font-medium">Review unavailable</span>
          <InlineNoticeText>
            <span>This review is expired, already decided, or not yours.</span>
          </InlineNoticeText>
        </InlineNotice>
      ) : (
        <div className="flex max-w-2xl flex-col gap-4">
          <p>
            <span className="font-medium">{review.data.text}</span>
          </p>
          {review.data.tool ? (
            <p>
              <span>Tool: {review.data.tool}</span>
            </p>
          ) : null}
          {review.data.arguments ? (
            <pre className="overflow-auto rounded-md border p-3 text-sm">
              <span>{review.data.arguments}</span>
            </pre>
          ) : null}
          <div className="flex gap-2">
            <Button
              type="button"
              disabled={submit.isPending}
              onClick={() =>
                submit.mutate({
                  taskId,
                  approvalId,
                  ruling: "approve",
                })
              }
            >
              <span>{submit.isPending ? "Submitting…" : "Approve"}</span>
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={submit.isPending}
              onClick={() =>
                submit.mutate({
                  taskId,
                  approvalId,
                  ruling: "deny",
                })
              }
            >
              <span>Deny</span>
            </Button>
          </div>
        </div>
      )}
    </PageLayout>
  );
}
