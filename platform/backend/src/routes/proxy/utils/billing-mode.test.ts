import { describe, expect, test } from "vitest";
import { anthropicAdapterFactory } from "../adapters/anthropic";
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
