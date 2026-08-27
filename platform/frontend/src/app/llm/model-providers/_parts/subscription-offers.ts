import {
  SUBSCRIPTION_CREDENTIAL_KINDS,
  SUBSCRIPTION_CREDENTIALS,
  type SubscriptionCredentialKind,
  subscriptionKindFromKeyMetadata,
} from "@archestra/shared";
import type {
  LlmProviderApiKeyFormValues,
  LlmProviderApiKeyResponse,
} from "@/components/llm-provider-api-key-form";

/** The providers the subscription registry can offer, narrowed to those. */
export type SubscriptionProvider =
  (typeof SUBSCRIPTION_CREDENTIALS)[SubscriptionCredentialKind]["provider"];

/**
 * One vendor subscription the viewer can connect, paired with the personal key
 * that already connects it (when there is one).
 */
export type SubscriptionOffer = {
  kind: SubscriptionCredentialKind;
  /** Short product name shown on the card. */
  name: string;
  provider: SubscriptionProvider;
  /** The viewer's key for this subscription, or null when not connected yet. */
  credential: LlmProviderApiKeyResponse | null;
  /** Prefill for the connect dialog, so it opens on the right auth mode. */
  defaultValues: Partial<LlmProviderApiKeyFormValues>;
};

/** The minimum a stored key has to carry to be matched against the registry. */
type MatchableCredential = Pick<LlmProviderApiKeyResponse, "provider"> & {
  scope?: LlmProviderApiKeyResponse["scope"];
  subscriptionKind?: SubscriptionCredentialKind | null;
};

/**
 * The subscription a stored key connects, or null for an ordinary API key.
 *
 * Subscriptions are always personal — a shared key on the same provider is an
 * ordinary credential no matter what it is named.
 */
export function subscriptionKindOfCredential(
  credential: MatchableCredential,
): SubscriptionCredentialKind | null {
  if (credential.scope !== "personal") return null;
  return (
    SUBSCRIPTION_CREDENTIAL_KINDS.find((kind) => {
      const { provider, marker } = SUBSCRIPTION_CREDENTIALS[kind];
      if (credential.provider !== provider) return false;
      // A credential-level subscription shares its provider with ordinary API
      // keys, so match on the kind the backend resolved from the stored secret;
      // a provider-level one is identified by its provider alone. Display names
      // are deliberately never consulted: they are mutable, and an ordinary key
      // is allowed to carry a registry label.
      return (
        marker === null || subscriptionKindFromKeyMetadata(credential) === kind
      );
    }) ?? null
  );
}

/**
 * Every subscription in the shared registry, in registry order, resolved
 * against the keys the viewer already has. Derived rather than hand-listed so a
 * new registry entry reaches this page without editing it.
 */
export function buildSubscriptionOffers(
  credentials: LlmProviderApiKeyResponse[],
): SubscriptionOffer[] {
  return SUBSCRIPTION_CREDENTIAL_KINDS.map((kind) => {
    const { provider, displayName, marker } = SUBSCRIPTION_CREDENTIALS[kind];
    return {
      kind,
      name: displayName,
      provider,
      credential:
        credentials.find(
          (credential) => subscriptionKindOfCredential(credential) === kind,
        ) ?? null,
      defaultValues: {
        name: displayName,
        provider,
        scope: "personal" as const,
        // Credential-level subscriptions share their provider with ordinary API
        // keys, so the form has to open on the subscription tab. Provider-level
        // ones have no tabs and ignore this.
        ...(marker !== null ? { authMethod: "subscription" as const } : {}),
      },
    };
  });
}
