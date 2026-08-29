import { describe, expect, it } from "vitest";
import {
  PROVIDERS_REQUIRING_PER_USER_CREDENTIAL,
  providerRequiresPerUserCredential,
} from "./model-constants";
import {
  credentialRequiresPerUserScope,
  isCredentialLevelSubscriptionProvider,
  isSubscriptionCredential,
  perUserCredentialLabel,
  SUBSCRIPTION_CREDENTIAL_KINDS,
  SUBSCRIPTION_CREDENTIALS,
  stripBearerTransportPrefix,
  subscriptionKindForProvider,
  subscriptionKindFromCredential,
  subscriptionKindFromKeyMetadata,
} from "./subscription-credentials";

/** A stored secret shaped like a real credential-level subscription value. */
const chatgptCredential = `${SUBSCRIPTION_CREDENTIALS.chatgpt.marker}${Buffer.from(
  JSON.stringify({ refreshToken: "rt", accountId: "acc" }),
).toString("base64")}`;

describe("subscriptionKindFromCredential", () => {
  it("identifies a credential-level subscription by its marker", () => {
    expect(subscriptionKindFromCredential(chatgptCredential)).toBe("chatgpt");
    expect(isSubscriptionCredential(chatgptCredential)).toBe(true);
  });

  it("normalizes case-insensitive Bearer transport wrappers before classification", () => {
    expect(subscriptionKindFromCredential(`bearer ${chatgptCredential}`)).toBe(
      "chatgpt",
    );
    expect(isSubscriptionCredential(`BeArEr: ${chatgptCredential}`)).toBe(true);
    expect(stripBearerTransportPrefix(`BEARER ${chatgptCredential}`)).toBe(
      chatgptCredential,
    );
  });

  it("treats plain API keys and absent secrets as non-subscription", () => {
    expect(subscriptionKindFromCredential("sk-plain-openai-key")).toBeNull();
    expect(subscriptionKindFromCredential(undefined)).toBeNull();
    expect(subscriptionKindFromCredential(null)).toBeNull();
    expect(isSubscriptionCredential("sk-plain-openai-key")).toBe(false);
  });

  it("does not match provider-level subscriptions, which carry no marker", () => {
    // A GitHub Copilot key is a raw OAuth token — per-user by provider, not by
    // marker — so secret inspection must not claim it.
    expect(subscriptionKindFromCredential("gho_xxx")).toBeNull();
  });
});

describe("registry coverage", () => {
  it("gives every inherently per-user provider a registry entry", () => {
    // The connect surfaces pick a sign-in flow by looking the provider up here.
    // A per-user provider missing from the registry would render the API-key
    // field instead of its sign-in button, with no way to connect an account.
    for (const provider of PROVIDERS_REQUIRING_PER_USER_CREDENTIAL) {
      expect(subscriptionKindForProvider(provider)).not.toBeNull();
    }
  });

  it("gives every entry a marker iff its provider also takes API keys", () => {
    for (const kind of SUBSCRIPTION_CREDENTIAL_KINDS) {
      const { provider, marker } = SUBSCRIPTION_CREDENTIALS[kind];
      expect(isCredentialLevelSubscriptionProvider(provider)).toBe(
        marker !== null,
      );
      // Provider-level subscriptions are per-user by provider; credential-level
      // ones must NOT be, or every plain API key on that provider would be
      // forced to personal scope.
      expect(providerRequiresPerUserCredential(provider)).toBe(marker === null);
    }
  });

  it("gives every provider at most one subscription", () => {
    // subscriptionKindForProvider and the connect surfaces .find() the first
    // matching entry — a second subscription on the same provider would be
    // silently unreachable.
    const providers = SUBSCRIPTION_CREDENTIAL_KINDS.map(
      (kind) => SUBSCRIPTION_CREDENTIALS[kind].provider,
    );
    expect(new Set(providers).size).toBe(providers.length);
  });

  it("keeps markers pairwise prefix-free", () => {
    // subscriptionKindFromCredential returns the first marker the secret
    // starts with — a marker that is a prefix of another would shadow it.
    const markers = SUBSCRIPTION_CREDENTIAL_KINDS.map(
      (kind): string | null => SUBSCRIPTION_CREDENTIALS[kind].marker,
    ).filter((marker): marker is string => marker !== null);
    for (const a of markers) {
      for (const b of markers) {
        if (a !== b) {
          expect(a.startsWith(b)).toBe(false);
        }
      }
    }
  });
});

describe("subscriptionKindFromKeyMetadata", () => {
  it("prefers the server-derived kind when present", () => {
    expect(
      subscriptionKindFromKeyMetadata({
        provider: "xai",
        name: "renamed by the user",
        subscriptionKind: "x-premium",
      }),
    ).toBe("x-premium");
  });

  it("does not infer credential kind from a mutable display name", () => {
    expect(
      subscriptionKindFromKeyMetadata({
        provider: "xai",
        name: "SuperGrok",
      }),
    ).toBeNull();
    expect(
      subscriptionKindFromKeyMetadata({
        provider: "openai",
        name: " chatgpt subscription ",
      }),
    ).toBeNull();
  });

  it("treats a renamed key with no metadata as an ordinary key", () => {
    expect(
      subscriptionKindFromKeyMetadata({
        provider: "xai",
        name: "my grok key",
      }),
    ).toBeNull();
  });
});

describe("isCredentialLevelSubscriptionProvider", () => {
  it("is true only for providers that also accept ordinary API keys", () => {
    expect(isCredentialLevelSubscriptionProvider("openai")).toBe(true);
    // Provider-level subscriptions need no secret inspection.
    expect(isCredentialLevelSubscriptionProvider("github-copilot")).toBe(false);
    expect(isCredentialLevelSubscriptionProvider("anthropic")).toBe(false);
  });
});

describe("credentialRequiresPerUserScope", () => {
  it("treats a ChatGPT-subscription openai key as per-user", () => {
    expect(
      credentialRequiresPerUserScope({
        provider: "openai",
        apiKey: chatgptCredential,
      }),
    ).toBe(true);
    expect(
      credentialRequiresPerUserScope({
        provider: "openai",
        apiKey: `bearer ${chatgptCredential}`,
      }),
    ).toBe(true);
  });

  it("treats a plain openai API key as NOT per-user", () => {
    expect(
      credentialRequiresPerUserScope({
        provider: "openai",
        apiKey: "sk-plain",
      }),
    ).toBe(false);
  });

  it("keeps inherently per-user providers per-user regardless of the secret", () => {
    expect(
      credentialRequiresPerUserScope({
        provider: "github-copilot",
        apiKey: "gho_x",
      }),
    ).toBe(true);
    expect(
      credentialRequiresPerUserScope({
        provider: "microsoft-365-copilot",
        apiKey: null,
      }),
    ).toBe(true);
  });
});

describe("perUserCredentialLabel", () => {
  it("labels a credential-level subscription by its subscription name", () => {
    expect(
      perUserCredentialLabel({
        provider: "openai",
        apiKey: chatgptCredential,
      }),
    ).toBe("ChatGPT Subscription");
    expect(
      perUserCredentialLabel({
        provider: "openai",
        apiKey: `Bearer: ${chatgptCredential}`,
      }),
    ).toBe("ChatGPT Subscription");
  });

  it("labels other per-user providers by provider name", () => {
    expect(
      perUserCredentialLabel({ provider: "github-copilot", apiKey: "gho_x" }),
    ).toBe("github-copilot");
  });
});
