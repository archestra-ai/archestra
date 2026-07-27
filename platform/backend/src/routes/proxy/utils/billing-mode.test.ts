import { describe, expect, test } from "vitest";
import { anthropicAdapterFactory } from "../adapters/anthropic";
import { openaiAdapterFactory } from "../adapters/openai";
import { openAiResponsesAdapterFactory } from "../adapters/openai-responses";
import { encodeOpenAiCodexCredential } from "@/services/openai-codex-credentials";
import { resolveInteractionBillingMode } from "./billing-mode";

describe("resolveInteractionBillingMode", () => {
  test("subscription credential => subscription", () => {
    expect(
      resolveInteractionBillingMode({
        isSubscriptionCredential: true,
        autodetectEnabled: true,
      }),
    ).toBe("subscription");
  });

  test("non-subscription credential stays metered", () => {
    expect(
      resolveInteractionBillingMode({
        isSubscriptionCredential: false,
        autodetectEnabled: true,
      }),
    ).toBe("metered");
  });

  test("autodetect disabled forces metered", () => {
    expect(
      resolveInteractionBillingMode({
        isSubscriptionCredential: true,
        autodetectEnabled: false,
      }),
    ).toBe("metered");
  });
});

describe("anthropic isSubscriptionCredential (credential format)", () => {
  const isSubscription = (credential: string | undefined) =>
    anthropicAdapterFactory.isSubscriptionCredential?.(credential) ?? false;

  test("forwarded OAuth access token (Claude Code passthrough) => subscription", () => {
    expect(isSubscription("Bearer:sk-ant-oat01-abc123")).toBe(true);
  });

  test("stored OAuth access token (no Bearer sentinel) => subscription", () => {
    expect(isSubscription("sk-ant-oat01-abc123")).toBe(true);
  });

  test("metered API key via x-api-key stays metered", () => {
    expect(isSubscription("sk-ant-api03-abc123")).toBe(false);
  });

  test("forwarded non-OAuth Bearer (e.g. Workload Identity) stays metered", () => {
    // A Bearer transport alone is not a subscription signal — only the
    // sk-ant-oat… token format is.
    expect(isSubscription("Bearer:ya29.some-wif-access-token")).toBe(false);
  });

  test("forwarded metered API key over Bearer stays metered", () => {
    expect(isSubscription("Bearer:sk-ant-api03-abc123")).toBe(false);
  });

  test("undefined credential stays metered", () => {
    expect(isSubscription(undefined)).toBe(false);
  });
});

describe("openai isSubscriptionCredential (Codex credential format)", () => {
  const codexCredential = encodeOpenAiCodexCredential({
    refreshToken: "rt_test",
    accountId: "acct_test",
  });

  test("chatgpt-oauth encoded credential => subscription on chat completions", () => {
    expect(
      openaiAdapterFactory.isSubscriptionCredential?.(codexCredential),
    ).toBe(true);
  });

  test("chatgpt-oauth encoded credential => subscription on responses", () => {
    expect(
      openAiResponsesAdapterFactory.isSubscriptionCredential?.(codexCredential),
    ).toBe(true);
  });

  test("plain sk- API key stays metered", () => {
    expect(
      openaiAdapterFactory.isSubscriptionCredential?.("sk-proj-abc123"),
    ).toBe(false);
    expect(
      openAiResponsesAdapterFactory.isSubscriptionCredential?.(
        "sk-proj-abc123",
      ),
    ).toBe(false);
  });

  test("undefined credential stays metered", () => {
    expect(openaiAdapterFactory.isSubscriptionCredential?.(undefined)).toBe(
      false,
    );
  });
});
