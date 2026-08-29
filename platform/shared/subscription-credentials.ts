/**
 * Vendor subscriptions a user connects with their own account instead of an API
 * key — the single source of truth for every surface that has to treat "this is
 * somebody's personal subscription" differently from "this is a shared service
 * key".
 *
 * Two shapes collapse into one registry here:
 *
 * - **Provider-level** (GitHub Copilot, Microsoft 365 Copilot): the provider
 *   itself only ever holds per-user credentials, so the provider name alone is
 *   enough to identify the subscription. These carry `marker: null`.
 * - **Credential-level** (ChatGPT Subscription on `openai`): the provider also
 *   accepts ordinary API keys, so only the stored secret distinguishes the two.
 *   These carry a `marker` prefix that the encoded credential starts with.
 *
 * Adding a subscription means adding an entry here. The per-user scoping rules,
 * the enforcement labels, the "Connect subscription" rows on Model Providers,
 * the inline connect card in chat, the chat key selector's connect entries, and
 * the no-key empty state all read from this map rather than branching on
 * provider names, so a new entry reaches all of them at once — plus its
 * device-flow component in the frontend's SubscriptionSignIn map, which the
 * compiler enforces.
 */

import { z } from "zod";
import {
  providerRequiresPerUserCredential,
  type SupportedProvider,
} from "./model-constants";

interface SubscriptionCredentialDefinition {
  /** The LLM provider this subscription authenticates against. */
  provider: SupportedProvider;
  /**
   * User-facing name of the subscription itself. Used as the name of the
   * provider key created on connect, in per-user enforcement messages, and as
   * the "Connect <label>" heading. Distinct from `displayName` where the
   * subscription's name differs from the product's (ChatGPT Subscription vs
   * ChatGPT).
   */
  label: string;
  /** Short product name, used for the Model Providers row. */
  displayName: string;
  /**
   * Prefix the encoded credential starts with, for credential-level
   * subscriptions. `null` for provider-level ones, where the provider is
   * per-user on its own and no secret inspection is needed.
   */
  marker: string | null;
  /** Vendor-specific copy for the connect surfaces. */
  connect: SubscriptionConnectCopy;
}

interface SubscriptionConnectCopy {
  /** Heading of the standalone connect dialogs ("Sign in with <vendor>"). */
  signInTitle: string;
  /** Subtitle under that heading explaining what connecting does. */
  signInDescription: string;
  /** Field label above the sign-in button. */
  accountLabel: string;
  /**
   * Line under that label explaining what signing in does. `null` falls back to
   * the provider's own description, which is what the provider-level
   * subscriptions already show.
   */
  signInHint: string | null;
  /** Headline of the "connected" confirmation card. */
  connectedTitle: string;
  /** Body of the "connected" confirmation card. */
  connectedDescription: string;
  /** Explains why keys for this subscription can only be personal-scope. */
  perUserScopeReason: string;
}

export const SUBSCRIPTION_CREDENTIALS = {
  chatgpt: {
    provider: "openai",
    label: "ChatGPT Subscription",
    displayName: "ChatGPT",
    marker: "chatgpt-oauth:",
    connect: {
      signInTitle: "Sign in with ChatGPT",
      signInDescription:
        "Connect your ChatGPT account to use your subscription",
      accountLabel: "ChatGPT Subscription",
      signInHint:
        "No API key needed — just Sign in with the OpenAI account to connect your ChatGPT subscription. Keys are per-user: everyone using a Codex model signs in with their own account.",
      connectedTitle: "ChatGPT account connected",
      connectedDescription:
        "Your Codex/ChatGPT subscription is linked through your ChatGPT account.",
      perUserScopeReason:
        "ChatGPT subscription keys are per-user — each person connects their own ChatGPT account, so they can only be personal.",
    },
  },
  "github-copilot": {
    provider: "github-copilot",
    label: "GitHub Copilot",
    displayName: "GitHub Copilot",
    marker: null,
    connect: {
      signInTitle: "Sign in with GitHub Copilot",
      signInDescription: "Connect your GitHub Copilot subscription",
      accountLabel: "GitHub Copilot account",
      signInHint: null,
      connectedTitle: "GitHub account connected",
      connectedDescription:
        "Your Copilot subscription is linked through your GitHub account.",
      perUserScopeReason:
        "GitHub Copilot keys are per-user — each person connects their own account, so they can only be personal.",
    },
  },
  "microsoft-365-copilot": {
    provider: "microsoft-365-copilot",
    label: "Microsoft 365 Copilot",
    displayName: "Microsoft 365 Copilot",
    marker: null,
    connect: {
      signInTitle: "Sign in with Microsoft 365 Copilot",
      signInDescription: "Connect your Microsoft 365 Copilot subscription",
      accountLabel: "Microsoft 365 Copilot account",
      signInHint: null,
      connectedTitle: "Microsoft account connected",
      connectedDescription:
        "Your Microsoft 365 Copilot license is linked through your Microsoft account.",
      perUserScopeReason:
        "Microsoft 365 Copilot keys are per-user — each person connects their own account, so they can only be personal.",
    },
  },
  "x-premium": {
    provider: "xai",
    label: "SuperGrok",
    displayName: "SuperGrok",
    marker: "xai-subscription:",
    connect: {
      signInTitle: "Sign in with Grok",
      signInDescription: "Connect your SuperGrok subscription",
      accountLabel: "SuperGrok account",
      signInHint:
        "No API key needed — just Sign in with the Grok account that carries your SuperGrok subscription. Keys are per-user: everyone using a Grok model signs in with their own account.",
      connectedTitle: "Grok account connected",
      connectedDescription:
        "Your SuperGrok subscription is linked through your Grok account.",
      perUserScopeReason:
        "SuperGrok keys are per-user — each person connects their own Grok account, so they can only be personal.",
    },
  },
} as const satisfies Record<string, SubscriptionCredentialDefinition>;

export type SubscriptionCredentialKind = keyof typeof SUBSCRIPTION_CREDENTIALS;

/**
 * Display name of the OpenAI "ChatGPT Subscription" (Codex) auth mode — the
 * credential-level per-user case on the `openai` provider. Kept as a named
 * export because the ChatGPT connect flows reference it directly; it is the
 * registry's label, not a second source of truth.
 */
export const CHATGPT_SUBSCRIPTION_LABEL =
  SUBSCRIPTION_CREDENTIALS.chatgpt.label;

export const SUBSCRIPTION_CREDENTIAL_KINDS = Object.keys(
  SUBSCRIPTION_CREDENTIALS,
) as SubscriptionCredentialKind[];

/** Wire schema for the kind, derived from the registry so the two can't drift. */
export const SubscriptionCredentialKindSchema = z.enum(
  SUBSCRIPTION_CREDENTIAL_KINDS as [
    SubscriptionCredentialKind,
    ...SubscriptionCredentialKind[],
  ],
);

const CREDENTIAL_LEVEL_SUBSCRIPTION_PROVIDERS = new Set<string>(
  SUBSCRIPTION_CREDENTIAL_KINDS.filter(
    (kind) => SUBSCRIPTION_CREDENTIALS[kind].marker !== null,
  ).map((kind) => SUBSCRIPTION_CREDENTIALS[kind].provider),
);

/**
 * True for providers where a stored secret may be either an ordinary API key or
 * a credential-level subscription, so telling the two apart requires decrypting
 * and inspecting the secret rather than reading the provider name. Takes a
 * plain string so callers holding a loosely-typed row can ask directly.
 */
export function isCredentialLevelSubscriptionProvider(
  provider: string,
): boolean {
  return CREDENTIAL_LEVEL_SUBSCRIPTION_PROVIDERS.has(provider);
}

/**
 * The subscription a stored secret encodes, or null when it is an ordinary API
 * key. Only credential-level subscriptions are detectable this way — a
 * provider-level one has no marker, because its provider is already per-user.
 */
export function subscriptionKindFromCredential(
  value: string | null | undefined,
): SubscriptionCredentialKind | null {
  const credential = stripBearerTransportPrefix(value);
  if (typeof credential !== "string") {
    return null;
  }
  for (const kind of SUBSCRIPTION_CREDENTIAL_KINDS) {
    const { marker } = SUBSCRIPTION_CREDENTIALS[kind];
    if (marker !== null && credential.startsWith(marker)) {
      return kind;
    }
  }
  return null;
}

/** Remove an HTTP/internal Bearer transport wrapper before marker inspection. */
export function stripBearerTransportPrefix<T extends string | null | undefined>(
  value: T,
): T extends string ? string : T {
  return (
    typeof value === "string" ? value.replace(/^Bearer[:\s]+/i, "") : value
  ) as T extends string ? string : T;
}

/**
 * Minimal key metadata every list/get surface already carries. Structural so
 * the generated API key type and trimmed picks of it both satisfy it.
 */
interface SubscriptionKeyMetadata {
  provider: string;
  /** Mutable display name carried by full key rows; deliberately ignored. */
  name?: string;
  subscriptionKind?: SubscriptionCredentialKind | null;
}

/**
 * The subscription a key's METADATA identifies, or null for an ordinary key.
 *
 * `subscriptionKind` is derived server-side by inspecting the resolved secret.
 * Display names are intentionally never used as an authentication signal: they
 * are mutable, and an ordinary API key is allowed to share a registry label.
 */
export function subscriptionKindFromKeyMetadata(
  key: SubscriptionKeyMetadata,
): SubscriptionCredentialKind | null {
  return key.subscriptionKind ?? null;
}

/**
 * The subscription offered on a provider, or null when the provider has none.
 *
 * Assumes one subscription per provider, which is what the vendors offer: a
 * provider either has a subscription tier or it doesn't. Should that ever stop
 * holding, callers picking a connect flow would need the kind passed in
 * explicitly rather than derived.
 */
export function subscriptionKindForProvider(
  provider: SupportedProvider,
): SubscriptionCredentialKind | null {
  return (
    SUBSCRIPTION_CREDENTIAL_KINDS.find(
      (kind) => SUBSCRIPTION_CREDENTIALS[kind].provider === provider,
    ) ?? null
  );
}

/**
 * True when a stored secret is a subscription credential rather than an API
 * key. These only work through the LLM proxy adapter that decodes the marker
 * and redeems a short-lived access token, so direct AI-SDK call paths must
 * refuse them rather than send the encoded refresh token as a bearer.
 */
export function isSubscriptionCredential(
  value: string | null | undefined,
): boolean {
  return subscriptionKindFromCredential(value) !== null;
}

/**
 * True when a specific credential must be governed as **per-user** — personal
 * scope only, owner-matched, never shared through team/org or multi-provider
 * (model-router) virtual keys. Two cases collapse here: the provider is
 * inherently per-user (GitHub / Microsoft Copilot), or the secret carries a
 * credential-level subscription marker on a provider that also takes API keys.
 *
 * Unlike `providerRequiresPerUserCredential` (provider-only), this is the
 * KEY-level check: pass the resolved secret so a subscription credential is
 * recognized.
 */
export function credentialRequiresPerUserScope(params: {
  provider: SupportedProvider;
  apiKey: string | null | undefined;
}): boolean {
  return (
    providerRequiresPerUserCredential(params.provider) ||
    isSubscriptionCredential(params.apiKey)
  );
}

/**
 * User-facing label for a per-user credential in enforcement messages: the
 * subscription's own name ("ChatGPT Subscription") reads better than the raw
 * provider it runs on ("openai").
 */
export function perUserCredentialLabel(params: {
  provider: SupportedProvider;
  apiKey: string | null | undefined;
}): string {
  const kind = subscriptionKindFromCredential(params.apiKey);
  return kind ? SUBSCRIPTION_CREDENTIALS[kind].label : params.provider;
}
