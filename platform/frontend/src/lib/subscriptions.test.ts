import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useSession } from "@/lib/auth/auth.query";
import { useFeature } from "@/lib/config/config.query";
import {
  asSubscriptionProvider,
  isSubscriptionKey,
  type SubscriptionCandidateKey,
  subscriptionBlockingSend,
  useSubscriptions,
} from "./subscriptions";

vi.mock("@/lib/auth/auth.query");
vi.mock("@/lib/config/config.query");

const ME = "user-1";

function signedInAs(userId: string | undefined) {
  vi.mocked(useSession).mockReturnValue({
    data: userId ? { user: { id: userId } } : undefined,
  } as ReturnType<typeof useSession>);
}

function subscriptionsFor(keys: SubscriptionCandidateKey[]) {
  const { result } = renderHook(() => useSubscriptions(keys));
  return Object.fromEntries(
    result.current.map((entry) => [entry.provider, entry]),
  );
}

describe("useSubscriptions", () => {
  beforeEach(() => {
    signedInAs(ME);
    vi.mocked(useFeature).mockReturnValue(true);
  });

  it("always surfaces all three subscriptions, connected or not", () => {
    const entries = subscriptionsFor([]);

    expect(Object.keys(entries).sort()).toEqual([
      "github-copilot",
      "microsoft-365-copilot",
      "openai",
    ]);
    expect(Object.values(entries).every((entry) => !entry.connected)).toBe(
      true,
    );
  });

  it("treats the viewer's own personal key as connected", () => {
    const entries = subscriptionsFor([
      {
        id: "key-1",
        provider: "github-copilot",
        scope: "personal",
        userId: ME,
      },
    ]);

    expect(entries["github-copilot"].connected).toBe(true);
    expect(entries["github-copilot"].apiKeyId).toBe("key-1");
  });

  it("does not treat another user's personal key as the viewer's connection", () => {
    // An agent can force someone else's pinned key into the list, and that key
    // spends their plan, not the viewer's.
    const entries = subscriptionsFor([
      {
        id: "key-1",
        provider: "github-copilot",
        scope: "personal",
        userId: "user-2",
      },
    ]);

    expect(entries["github-copilot"].connected).toBe(false);
    expect(entries["github-copilot"].apiKeyId).toBeNull();
  });

  it("does not treat an org-scoped key as a personal subscription", () => {
    const entries = subscriptionsFor([
      { id: "key-1", provider: "github-copilot", scope: "org", userId: null },
    ]);

    expect(entries["github-copilot"].connected).toBe(false);
  });

  it("distinguishes a ChatGPT subscription from a pasted OpenAI key", () => {
    const withApiKey = subscriptionsFor([
      { id: "key-1", provider: "openai", scope: "personal", userId: ME },
    ]);
    expect(withApiKey.openai.connected).toBe(false);

    const withSubscription = subscriptionsFor([
      {
        id: "key-2",
        provider: "openai",
        scope: "personal",
        userId: ME,
        isChatgptSubscription: true,
      },
    ]);
    expect(withSubscription.openai.connected).toBe(true);
    expect(withSubscription.openai.apiKeyId).toBe("key-2");
  });

  it("marks Microsoft 365 sign-in unavailable until an operator configures it", () => {
    vi.mocked(useFeature).mockReturnValue(false);

    const entries = subscriptionsFor([]);

    expect(entries["microsoft-365-copilot"].signInUnavailable).toBe(true);
    expect(entries["github-copilot"].signInUnavailable).toBe(false);
    expect(entries.openai.signInUnavailable).toBe(false);
  });
});

describe("isSubscriptionKey", () => {
  it("classifies credentials by shape, not by scope", () => {
    expect(isSubscriptionKey({ id: "a", provider: "github-copilot" })).toBe(
      true,
    );
    expect(
      isSubscriptionKey({ id: "b", provider: "microsoft-365-copilot" }),
    ).toBe(true);
    expect(isSubscriptionKey({ id: "c", provider: "anthropic" })).toBe(false);
  });

  it("only counts OpenAI when the credential is the ChatGPT subscription", () => {
    expect(isSubscriptionKey({ id: "a", provider: "openai" })).toBe(false);
    expect(
      isSubscriptionKey({
        id: "b",
        provider: "openai",
        isChatgptSubscription: true,
      }),
    ).toBe(true);
  });
});

describe("asSubscriptionProvider", () => {
  it("passes subscription providers through and rejects the rest", () => {
    expect(asSubscriptionProvider("openai")).toBe("openai");
    expect(asSubscriptionProvider("github-copilot")).toBe("github-copilot");
    expect(asSubscriptionProvider("microsoft-365-copilot")).toBe(
      "microsoft-365-copilot",
    );
    expect(asSubscriptionProvider("anthropic")).toBeNull();
    expect(asSubscriptionProvider(null)).toBeNull();
    expect(asSubscriptionProvider(undefined)).toBeNull();
  });
});

describe("subscriptionBlockingSend", () => {
  it("blocks on the pinned subscription model the viewer cannot use", () => {
    expect(
      subscriptionBlockingSend({
        needsConnect: true,
        needsConnectProvider: "openai",
        selectedModel: null,
      }),
    ).toBe("openai");
  });

  it("blocks on an explicitly selected per-user model without a connection", () => {
    expect(
      subscriptionBlockingSend({
        needsConnect: false,
        needsConnectProvider: null,
        selectedModel: {
          provider: "github-copilot",
          requiresUserConnection: true,
          isConnected: false,
        },
      }),
    ).toBe("github-copilot");
  });

  it("does not block a connected per-user model", () => {
    expect(
      subscriptionBlockingSend({
        needsConnect: false,
        needsConnectProvider: null,
        selectedModel: {
          provider: "github-copilot",
          requiresUserConnection: true,
          isConnected: true,
        },
      }),
    ).toBeNull();
  });

  it("does not block an ordinary keyed model", () => {
    expect(
      subscriptionBlockingSend({
        needsConnect: false,
        needsConnectProvider: null,
        selectedModel: { provider: "anthropic" },
      }),
    ).toBeNull();
  });

  it("never blocks on a provider that has no subscription sign-in", () => {
    // needsConnect with a non-subscription provider has no CTA to offer, so
    // sending falls through to the existing backend error path.
    expect(
      subscriptionBlockingSend({
        needsConnect: true,
        needsConnectProvider: "anthropic",
        selectedModel: null,
      }),
    ).toBeNull();
  });
});
