"use client";

import type { CopilotPlan } from "@archestra/shared";
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

/** The GitHub Copilot plans an admin turned off; absent means offered. */
type HiddenCopilotPlans = Partial<Record<CopilotPlan, boolean>>;

/**
 * Whether a GitHub Copilot account is still missing that this organization
 * offers: a sign-in, a plan, or both.
 */
export function copilotAccountMissing(
  keys: readonly CopilotAccountKey[],
  hiddenPlans: HiddenCopilotPlans = {},
): boolean {
  return (
    (!hiddenPlans.personal && !keys.some((key) => !key.isGithubAppKey)) ||
    (!hiddenPlans.enterprise && !keys.some((key) => key.isGithubAppKey))
  );
}

/**
 * The GitHub Copilot accounts not connected yet, one card each, as the Model
 * Providers page offers them: the person's own subscription (a sign-in on the
 * spot) and an enterprise plan (a GitHub App on a GitHub organization, through
 * the same wizard). With no account at all both cards stand in for the
 * command; once one is connected the other stays on offer next to the account
 * in use; with both connected there is nothing to show. A plan an admin
 * turned off gets no card.
 */
export function CopilotAccountCards({
  keys,
  hiddenPlans = {},
  pending,
  onToken,
  className,
}: {
  keys: readonly CopilotAccountKey[];
  hiddenPlans?: HiddenCopilotPlans;
  /** The personal key is being saved: the sign-in waits for it. */
  pending: boolean;
  /** Receives the GitHub token of a completed personal sign-in. */
  onToken: (token: string) => void | Promise<void>;
  className?: string;
}) {
  const [connectingPlan, setConnectingPlan] = useState(false);
  const offerOwn =
    !hiddenPlans.personal && !keys.some((key) => !key.isGithubAppKey);
  const offerPlan =
    !hiddenPlans.enterprise && !keys.some((key) => key.isGithubAppKey);
  if (!offerOwn && !offerPlan) return null;
  return (
    <div
      className={cn(
        "grid gap-3",
        offerOwn && offerPlan && "sm:grid-cols-2",
        className,
      )}
      data-testid="copilot-account-cards"
    >
      {offerOwn && (
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
      {offerPlan && (
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
