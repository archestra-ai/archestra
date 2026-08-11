import {
  providerRequiresPerUserCredential,
  type SubscriptionCredentialKind,
  type SupportedProvider,
  subscriptionKindFromKeyMetadata,
} from "@archestra/shared";

/**
 * Minimal key shape needed to decide "is this somebody's personal subscription
 * credential". Structural so both the full generated key type and trimmed picks
 * of it satisfy the predicate.
 */
interface SubscriptionCheckableLlmKey {
  provider: SupportedProvider;
  name: string;
  subscriptionKind?: SubscriptionCredentialKind | null;
  isChatgptSubscription?: boolean;
}

/**
 * True when a key is a personal subscription credential (ChatGPT, X Premium,
 * Copilot, …) rather than an ordinary shareable API key. Surfaces that can only
 * use plain API keys (e.g. Knowledge embeddings/connections) filter on this so
 * they never offer a credential the backend will reject.
 */
export function isPersonalSubscription(key: SubscriptionCheckableLlmKey) {
  return (
    subscriptionKindFromKeyMetadata(key) != null ||
    providerRequiresPerUserCredential(key.provider)
  );
}
