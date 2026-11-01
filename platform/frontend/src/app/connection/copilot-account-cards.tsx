"use client";

import { useState } from "react";
import { CopilotOrganizationConnectDialog } from "@/app/llm/model-providers/_parts/copilot-organization-connect-dialog";
import { SubscriptionCard } from "@/app/llm/model-providers/_parts/subscription-provider-cards";
import { GithubCopilotSignIn } from "@/components/github-copilot-sign-in";
import { cn } from "@/lib/utils/tailwind";

/** A GitHub Copilot key the person may use, as the available-keys list has it. */
export interface CopilotAccountKey {
  id: string;
  /** An organization's plan through a GitHub App, rather than a sign-in. */
  isGithubAppKey?: boolean | null;
}

/** Whether a GitHub Copilot account is still missing: a sign-in, a plan, or both. */
export function copilotAccountMissing(
  keys: readonly CopilotAccountKey[],
): boolean {
  return (
    !keys.some((key) => !key.isGithubAppKey) ||
    !keys.some((key) => key.isGithubAppKey)
  );
}

/**
 * The GitHub Copilot accounts not connected yet, one card each, as the Model
 * Providers page offers them: the person's own subscription (a sign-in on the
 * spot) and an enterprise plan (a GitHub App on a GitHub organization, through
 * the same wizard). With no account at all both cards stand in for the
 * command; once one is connected the other stays on offer next to the account
 * in use; with both connected there is nothing to show.
 */
export function CopilotAccountCards({
  keys,
  pending,
  onToken,
  className,
}: {
  keys: readonly CopilotAccountKey[];
  /** The personal key is being saved: the sign-in waits for it. */
  pending: boolean;
  /** Receives the GitHub token of a completed personal sign-in. */
  onToken: (token: string) => void | Promise<void>;
  className?: string;
}) {
  const [connectingPlan, setConnectingPlan] = useState(false);
  const hasOwn = keys.some((key) => !key.isGithubAppKey);
  const hasPlan = keys.some((key) => key.isGithubAppKey);
  if (hasOwn && hasPlan) return null;
  return (
    <div
      className={cn(
        "grid gap-3",
        !hasOwn && !hasPlan && "sm:grid-cols-2",
        className,
      )}
      data-testid="copilot-account-cards"
    >
      {!hasOwn && (
        <SubscriptionCard
          testId="copilot-account-card-personal"
          kind="github-copilot"
          provider="github-copilot"
          name="Personal subscription"
          description="Sign in with your own GitHub Copilot subscription."
          isLoading={false}
          status="not-connected"
          connectAction={
            <GithubCopilotSignIn disabled={pending} onToken={onToken} />
          }
        />
      )}
      {!hasPlan && (
        <SubscriptionCard
          testId="copilot-account-card-enterprise"
          kind="github-copilot"
          provider="github-copilot"
          name="Enterprise plan"
          description="Connect a GitHub Copilot plan paid by your GitHub organization, through a GitHub App. Can be shared."
          isLoading={false}
          status="not-connected"
          onConnect={() => setConnectingPlan(true)}
          connectPermissions={{ llmProviderApiKey: ["create"] }}
        />
      )}
      {connectingPlan && (
        <CopilotOrganizationConnectDialog
          open
          onOpenChange={(open) => {
            if (!open) setConnectingPlan(false);
          }}
        />
      )}
    </div>
  );
}
