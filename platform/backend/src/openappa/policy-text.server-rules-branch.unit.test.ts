import { describe, expect, test } from "vitest";
import { isServerRulesBranch, serverRulesBranch } from "./policy-text";

describe("server rules branches", () => {
  test("a branch this deployment opens for a server is recognised, for that server or any", () => {
    const branch = serverRulesBranch("payments_api", "0a1b2c3d");
    expect(branch).toBe("archestra/openappa-server-payments_api-0a1b2c3d");
    expect(isServerRulesBranch(branch)).toBe(true);
    expect(isServerRulesBranch(branch, "payments_api")).toBe(true);
    expect(isServerRulesBranch(branch, "payments")).toBe(false);
    // A hyphenated prefix keeps its own hyphens apart from the suffix's.
    const hyphenated = serverRulesBranch("context7-docs", "deadbeef");
    expect(isServerRulesBranch(hyphenated)).toBe(true);
    expect(isServerRulesBranch(hyphenated, "context7-docs")).toBe(true);
    expect(isServerRulesBranch(hyphenated, "context7")).toBe(false);
  });

  test("other branches of the deployment, and anything else, are not", () => {
    for (const branch of [
      "archestra/openappa-self-service",
      "archestra/openappa-0a1b2c3d-4e5f-6a7b-8c9d-0e1f2a3b4c5d",
      "archestra/openappa-setup-0a1b2c3d",
      "archestra/openappa-server-",
      "archestra/openappa-server-payments_api",
      "archestra/openappa-server-payments_api-0A1B2C3D",
      "archestra/openappa-server-payments_api-0a1b2c3",
      "archestra/openappa-server-Payments.API-0a1b2c3d",
      "riley/payments-rules",
      "",
    ])
      expect(isServerRulesBranch(branch), branch).toBe(false);
  });
});
