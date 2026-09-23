"use client";

import { GitPullRequestArrow } from "lucide-react";
import { Button } from "@/components/ui/button";
import { InlineNotice, InlineNoticeText } from "@/components/ui/inline-notice";
import {
  type PolicyDeclarations,
  useAcceptHeldPull,
} from "@/lib/openappa-batteries.query";

/** A pulled document the sync fetched and did not publish, with the accept that publishes it. */
export function HeldPullNotice({
  heldPull,
  canManage,
  canBind,
}: {
  heldPull: NonNullable<PolicyDeclarations["heldPull"]>;
  canManage: boolean;
  canBind: boolean;
}) {
  const accept = useAcceptHeldPull();
  // Publishing the held text performs what it was held for: dropping an entry
  // is a policy edit, rebinding a variable hands a credential to other code.
  const mayAccept = heldPull.reasons.includes("changes_credentials")
    ? canBind
    : canManage;
  return (
    <InlineNotice variant="warning">
      <GitPullRequestArrow />
      <span className="font-medium">Repository text held</span>
      <InlineNoticeText>
        {heldPull.reasons.map((reason) => (
          <div key={reason}>{HELD_PULL_REASONS[reason]}</div>
        ))}
      </InlineNoticeText>
      {mayAccept && (
        <Button
          size="sm"
          variant="outline"
          className="ml-auto"
          disabled={accept.isPending}
          onClick={() => accept.mutate()}
        >
          <span>Accept repository text</span>
        </Button>
      )}
    </InlineNotice>
  );
}

const HELD_PULL_REASONS: Record<
  NonNullable<PolicyDeclarations["heldPull"]>["reasons"][number],
  string
> = {
  drops_batteries:
    "The repository text drops batteries this deployment declared",
  changes_credentials:
    "The repository text changes which credentials batteries read",
};
