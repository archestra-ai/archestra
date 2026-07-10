import { describe, expect, test } from "vitest";
import { resolveInteractionBillingMode } from "./billing-mode";

describe("resolveInteractionBillingMode", () => {
  const passthrough = {
    providerApiKeyRow: null,
    isForwardedSubscriptionCredential: true,
    isClaudeClientRequest: true,
    autodetectEnabled: true,
  };

  test("a DB-managed key's configured mode wins (subscription)", () => {
    expect(
      resolveInteractionBillingMode({
        ...passthrough,
        providerApiKeyRow: { billingMode: "subscription" },
        // Even with no passthrough signals, the key's mode is authoritative.
        isForwardedSubscriptionCredential: false,
        isClaudeClientRequest: false,
      }),
    ).toBe("subscription");
  });

  test("a DB-managed key's configured mode wins (metered) over passthrough signals", () => {
    expect(
      resolveInteractionBillingMode({
        ...passthrough,
        providerApiKeyRow: { billingMode: "metered" },
      }),
    ).toBe("metered");
  });

  test("Claude client + forwarded OAuth Bearer passthrough => subscription", () => {
    expect(resolveInteractionBillingMode(passthrough)).toBe("subscription");
  });

  test("forwarded Bearer WITHOUT a Claude-client signal stays metered", () => {
    // Guards the BLOCKING case: a client forwarding a metered Bearer (e.g.
    // Workload Identity) carries no Claude body signal and must not be zeroed.
    expect(
      resolveInteractionBillingMode({
        ...passthrough,
        isClaudeClientRequest: false,
      }),
    ).toBe("metered");
  });

  test("Claude client WITHOUT a forwarded Bearer (x-api-key) stays metered", () => {
    // Claude Code on an API key uses x-api-key, not Bearer.
    expect(
      resolveInteractionBillingMode({
        ...passthrough,
        isForwardedSubscriptionCredential: false,
      }),
    ).toBe("metered");
  });

  test("autodetect disabled forces metered for passthrough", () => {
    expect(
      resolveInteractionBillingMode({
        ...passthrough,
        autodetectEnabled: false,
      }),
    ).toBe("metered");
  });

  test("autodetect disabled still honors an explicit key subscription mode", () => {
    expect(
      resolveInteractionBillingMode({
        ...passthrough,
        providerApiKeyRow: { billingMode: "subscription" },
        autodetectEnabled: false,
      }),
    ).toBe("subscription");
  });

  test("no key and no signals defaults to metered", () => {
    expect(
      resolveInteractionBillingMode({
        providerApiKeyRow: null,
        isForwardedSubscriptionCredential: false,
        isClaudeClientRequest: false,
        autodetectEnabled: true,
      }),
    ).toBe("metered");
  });
});
