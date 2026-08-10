import {
  providerRequiresPerUserCredential,
  type SubscriptionCredentialKind,
  type SupportedProvider,
} from "@archestra/shared";

/**
 * Minimal key shape needed to decide "is this somebody's personal subscription
 * credential". Structural so both the full generated key type and trimmed picks
 * of it satisfy the predicate.
 */
export interface SubscriptionCheckableLlmKey {
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
    key.subscriptionKind != null ||
    providerRequiresPerUserCredential(key.provider) ||
    // Legacy fallback: ChatGPT keys whose secret is unreadable to the metadata
    // endpoint carry no kind but are still recognized by the boolean flag or
    // their default name.
    (key.provider === "openai" &&
      (key.isChatgptSubscription === true ||
        key.name.trim().toLowerCase() === "chatgpt subscription"))
  );
}
