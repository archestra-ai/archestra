import { describe, expect, test } from "vitest";
import { isPersonalSubscription } from "@/lib/llm-key-subscription";

describe("isPersonalSubscription", () => {
  test("recognizes a key by its server-derived kind", () => {
    expect(
      isPersonalSubscription({
        provider: "xai",
        name: "renamed by the user",
        subscriptionKind: "x-premium",
      }),
    ).toBe(true);
  });

  test("recognizes an inherently per-user provider regardless of metadata", () => {
    expect(
      isPersonalSubscription({
        provider: "github-copilot",
        name: "GitHub Copilot",
      }),
    ).toBe(true);
  });

  test("falls back to the connect-flow name when the secret is unreadable", () => {
    // Vault-backed deployments: subscriptionKind arrives null even for a
    // connected subscription key, so the name the connect flow assigned is the
    // only remaining signal.
    expect(
      isPersonalSubscription({
        provider: "xai",
        name: "X Premium (SuperGrok)",
      }),
    ).toBe(true);
    expect(
      isPersonalSubscription({
        provider: "openai",
        name: "ChatGPT Subscription",
      }),
    ).toBe(true);
  });

  test("keeps the legacy ChatGPT boolean working", () => {
    expect(
      isPersonalSubscription({
        provider: "openai",
        name: "whatever",
        isChatgptSubscription: true,
      }),
    ).toBe(true);
  });

  test("treats plain API keys as shareable", () => {
    expect(
      isPersonalSubscription({ provider: "xai", name: "my grok key" }),
    ).toBe(false);
    expect(
      isPersonalSubscription({
        provider: "openai",
        name: "OpenAI Key",
        subscriptionKind: null,
      }),
    ).toBe(false);
  });

  test("does not match a subscription name on the wrong provider", () => {
    expect(
      isPersonalSubscription({
        provider: "openai",
        name: "X Premium (SuperGrok)",
      }),
    ).toBe(false);
  });
});
