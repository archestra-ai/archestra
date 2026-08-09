"use client";

import type { SubscriptionCredentialKind } from "@archestra/shared";
import type { ReactNode } from "react";
import { GithubCopilotSignIn } from "@/components/github-copilot-sign-in";
import { Microsoft365CopilotSignIn } from "@/components/microsoft-365-copilot-sign-in";
import { OpenaiCodexSignIn } from "@/components/openai-codex-sign-in";
import { XaiSubscriptionSignIn } from "@/components/xai-subscription-sign-in";

interface SubscriptionSignInProps {
  kind: SubscriptionCredentialKind;
  /**
   * Receives the secret to store as the provider key's credential — an OAuth
   * token for provider-level subscriptions, a marker-encoded credential for
   * credential-level ones. Either way the caller stores it verbatim through the
   * standard CreateLlmProviderApiKey path.
   */
  onSecret: (secret: string) => void;
  disabled?: boolean;
}

interface SignInFlowProps {
  onSecret: (secret: string) => void;
  disabled?: boolean;
}

/**
 * Maps a subscription to its device-flow sign-in. Each vendor's flow has its
 * own component and its own device endpoints, so this is the single place that
 * knows which one to render — every "Connect subscription" surface stays a
 * lookup instead of a chain of provider checks.
 *
 * Typed as a full Record, so adding a SUBSCRIPTION_CREDENTIALS entry without a
 * sign-in flow here is a compile error rather than a blank card at runtime.
 */
const SIGN_IN_FLOWS: Record<
  SubscriptionCredentialKind,
  (props: SignInFlowProps) => ReactNode
> = {
  chatgpt: ({ onSecret, disabled }) => (
    <OpenaiCodexSignIn onCredential={onSecret} disabled={disabled} />
  ),
  "github-copilot": ({ onSecret, disabled }) => (
    <GithubCopilotSignIn onToken={onSecret} disabled={disabled} />
  ),
  "microsoft-365-copilot": ({ onSecret, disabled }) => (
    <Microsoft365CopilotSignIn onToken={onSecret} disabled={disabled} />
  ),
  "x-premium": ({ onSecret, disabled }) => (
    <XaiSubscriptionSignIn onCredential={onSecret} disabled={disabled} />
  ),
};

export function SubscriptionSignIn({
  kind,
  onSecret,
  disabled,
}: SubscriptionSignInProps) {
  return SIGN_IN_FLOWS[kind]({ onSecret, disabled });
}
