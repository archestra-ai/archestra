"use client";

import { GitPullRequestArrow } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import {
  InlineNotice,
  InlineNoticeBody,
  InlineNoticeText,
} from "@/components/ui/inline-notice";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { useAcceptHeldPull } from "@/lib/openappa-batteries.query";
import { useAppaGithubSync } from "@/lib/openappa-github-sync.query";

/**
 * A pulled policy that changes what the repository can't authorize on its own
 * (a battery's credential, or dropping a battery) waits here for approval.
 * Every page that reports the sync shows this one notice, so the same event
 * reads the same everywhere.
 */
export function HeldPullNotice({
  held,
  batteriesLink = false,
}: {
  held: HeldPull;
  batteriesLink?: boolean;
}) {
  // Names the host when the viewer may read sync settings; reading the policy is enough for the rest.
  const { data } = useAppaGithubSync();
  const host = data ? "GitHub" : "the repository";
  const accept = useAcceptHeldPull();
  // Approving performs what the pull was held for: rebinding a credential hands
  // its value to other code, dropping a battery is a policy edit.
  const { data: canEditPolicy } = useHasPermissions({
    openappaPolicy: ["update"],
  });
  const { data: canBindCredentials } = useHasPermissions({
    openappaPolicy: ["update"],
    credential: ["update"],
  });
  const { reasons } = held;
  if (reasons.length === 0) return null;
  const mayApprove = reasons.includes("changes_credentials")
    ? canBindCredentials === true
    : canEditPolicy === true;
  return (
    <InlineNotice variant="warning">
      <GitPullRequestArrow aria-hidden />
      <InlineNoticeBody>
        <span className="font-medium">A change from {host} needs approval</span>
        <InlineNoticeText>
          {heldSummary(held.message, reasons)} Your current policy stays active
          until you approve.
          {batteriesLink && (
            <>
              {" "}
              <Link
                href="/openappa/batteries"
                className="font-medium underline underline-offset-4"
              >
                See batteries
              </Link>
            </>
          )}
        </InlineNoticeText>
      </InlineNoticeBody>
      {mayApprove && (
        <Button
          size="xs"
          variant="outline"
          className="ml-auto shrink-0"
          disabled={accept.isPending}
          onClick={() => accept.mutate()}
        >
          <span>Approve</span>
        </Button>
      )}
    </InlineNotice>
  );
}

/** A pull held for approval: why, and the server's sentence naming the changes. */
export type HeldPull = {
  reasons: Array<"drops_batteries" | "changes_credentials">;
  message: string | null | undefined;
};

// ===================== Internals =====================

/**
 * The server's sentence names each battery and credential. A hold recorded
 * before that wording falls back to one line per reason until the next pull.
 */
function heldSummary(
  message: string | null | undefined,
  reasons: Array<"drops_batteries" | "changes_credentials">,
) {
  if (message?.startsWith("The repository's policy")) return message;
  return reasons.map((reason) => GENERIC[reason]).join(" ");
}

const GENERIC = {
  changes_credentials: "The repository's policy gives batteries credentials.",
  drops_batteries: "The repository's policy removes batteries added here.",
} as const;
