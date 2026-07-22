"use client";

import {
  CHATGPT_SUBSCRIPTION_LABEL,
  type SupportedProvider,
} from "@archestra/shared";
import { useMemo } from "react";
import { useSession } from "@/lib/auth/auth.query";
import { useFeature } from "@/lib/config/config.query";

/**
 * Providers wired via a personal subscription sign-in rather than a pasted API
 * key. ChatGPT reuses the `openai` provider (the stored credential is an OAuth
 * blob, not an `sk-` key); Copilot/M365 are their own per-user providers.
 */
export type SubscriptionProvider =
  | "openai"
  | "github-copilot"
  | "microsoft-365-copilot";

export interface SubscriptionOption {
  provider: SubscriptionProvider;
  title: string;
  subtitle: string;
  /** Default name for the provider key created on sign-in. */
  keyName: string;
}

/**
 * The three subscriptions, always rendered as distinct entities even when the
 * user is signed in to none of them — a subscription the user cannot see is a
 * subscription they never sign in to.
 *
 * Lead with the differentiators — Microsoft 365 Copilot (rare) and GitHub
 * Copilot — then ChatGPT.
 */
export const SUBSCRIPTION_OPTIONS: SubscriptionOption[] = [
  {
    provider: "microsoft-365-copilot",
    title: "Microsoft 365 Copilot",
    subtitle: "Uses your Microsoft 365 Copilot license",
    keyName: "Microsoft 365 Copilot",
  },
  {
    provider: "github-copilot",
    title: "GitHub Copilot",
    subtitle: "Uses your GitHub Copilot seat",
    keyName: "GitHub Copilot",
  },
  {
    provider: "openai",
    title: CHATGPT_SUBSCRIPTION_LABEL,
    subtitle: "Usage counts against your ChatGPT plan",
    keyName: CHATGPT_SUBSCRIPTION_LABEL,
  },
];

/** Minimal key shape the subscription derivation needs. */
export interface SubscriptionCandidateKey {
  id: string;
  provider: SupportedProvider;
  scope?: string | null;
  userId?: string | null;
  isChatgptSubscription?: boolean;
}

export interface SubscriptionEntry extends SubscriptionOption {
  /** The signed-in user has their own credential for this subscription. */
  connected: boolean;
  /** Key id backing `connected`, for selecting the subscription in a picker. */
  apiKeyId: string | null;
  /** Sign-in cannot start because an operator hasn't configured it. */
  signInUnavailable: boolean;
}

/**
 * Resolves the three subscriptions against the keys the viewer can see.
 *
 * Connection is deliberately derived from the *viewer's own personal key*, not
 * from any key on the provider: a subscription is one person's plan, so an
 * org-scoped key for the same provider must never read as "you are signed in".
 * `GET /api/llm-provider-api-keys` already hides other users' personal keys, so
 * the `userId` check is belt-and-braces rather than the primary guard.
 */
export function useSubscriptions(
  keys: SubscriptionCandidateKey[],
): SubscriptionEntry[] {
  const { data: session } = useSession();
  const currentUserId = session?.user?.id;
  // Microsoft 365 Copilot needs an operator-set Entra client id; without it the
  // device-flow start 400s. Surface why instead of an enabled-but-dead button.
  const m365Configured = useFeature("microsoft365CopilotSignInConfigured");

  return useMemo(
    () =>
      SUBSCRIPTION_OPTIONS.map((option) => {
        const key = keys.find((candidate) =>
          keyBacksSubscription({
            key: candidate,
            provider: option.provider,
            currentUserId,
          }),
        );

        return {
          ...option,
          connected: !!key,
          apiKeyId: key?.id ?? null,
          signInUnavailable:
            option.provider === "microsoft-365-copilot" &&
            m365Configured === false,
        };
      }),
    [keys, currentUserId, m365Configured],
  );
}

/** Narrows any provider to a subscription provider, or null when it is not one. */
export function asSubscriptionProvider(
  provider: SupportedProvider | null | undefined,
): SubscriptionProvider | null {
  return provider != null &&
    SUBSCRIPTION_OPTIONS.some((option) => option.provider === provider)
    ? (provider as SubscriptionProvider)
    : null;
}

/**
 * The subscription the viewer must sign in to before the composer can send,
 * or null when sending is fine.
 *
 * Two ways a dead subscription ends up selected:
 * - the agent (or org default) pins a subscription-backed model that is not in
 *   the viewer's available list (`needsConnect`, from
 *   `agentRequiresPerUserConnect`), or
 * - the viewer explicitly picked a per-user model they haven't connected
 *   (`requiresUserConnection && !isConnected` on the model row).
 *
 * Without this gate the message sends anyway and dies at the provider with an
 * opaque "the model ended its turn without a reply" error.
 */
export function subscriptionBlockingSend(params: {
  needsConnect: boolean;
  needsConnectProvider: SupportedProvider | null | undefined;
  selectedModel:
    | {
        provider: SupportedProvider;
        requiresUserConnection?: boolean;
        isConnected?: boolean;
      }
    | null
    | undefined;
}): SubscriptionProvider | null {
  const { needsConnect, needsConnectProvider, selectedModel } = params;
  if (needsConnect) return asSubscriptionProvider(needsConnectProvider);
  if (selectedModel?.requiresUserConnection && !selectedModel.isConnected) {
    return asSubscriptionProvider(selectedModel.provider);
  }
  return null;
}

/** True when `key` is a subscription credential rather than a pasted API key. */
export function isSubscriptionKey(key: SubscriptionCandidateKey): boolean {
  return SUBSCRIPTION_OPTIONS.some(
    (option) =>
      option.provider === key.provider &&
      (option.provider !== "openai" || key.isChatgptSubscription === true),
  );
}

function keyBacksSubscription(params: {
  key: SubscriptionCandidateKey;
  provider: SubscriptionProvider;
  currentUserId?: string;
}): boolean {
  const { key, provider, currentUserId } = params;

  if (key.provider !== provider) return false;
  // A subscription is always personal-scope. `scope` is optional on the picker's
  // narrowed key type; when absent, fall through rather than reject.
  if (key.scope != null && key.scope !== "personal") return false;
  if (currentUserId && key.userId != null && key.userId !== currentUserId) {
    return false;
  }
  // `openai` also carries plain `sk-` API keys, so the ChatGPT subscription
  // needs the credential-shape discriminator to tell the two apart.
  if (provider === "openai") return key.isChatgptSubscription === true;
  return true;
}
