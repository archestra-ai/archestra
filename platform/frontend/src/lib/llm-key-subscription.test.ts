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

  test("does not treat a registry-label display name as credential metadata", () => {
    expect(
      isPersonalSubscription({
        provider: "xai",
        name: "SuperGrok",
      }),
    ).toBe(false);
    expect(
      isPersonalSubscription({
        provider: "openai",
        name: "ChatGPT Subscription",
      }),
    ).toBe(false);
  });

  test("keeps the legacy ChatGPT boolean working", () => {
    expect(
      isPersonalSubscription({
        provider: "openai",
        name: "whatever",
        subscriptionKind: "chatgpt",
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
        name: "SuperGrok",
      }),
    ).toBe(false);
  });
});
