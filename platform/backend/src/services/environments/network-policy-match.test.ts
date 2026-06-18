import { describe, expect, test } from "vitest";
import type { NetworkPolicy } from "@/types";
import { isHostAllowedByNetworkPolicy } from "./network-policy-match";

function policy(overrides: Partial<NetworkPolicy>): NetworkPolicy {
  return {
    egressMode: "restricted",
    domainPreset: "none",
    allowedDomains: [],
    allowedCidrs: [],
    ...overrides,
  };
}

describe("isHostAllowedByNetworkPolicy", () => {
  test("null (built-in) and unrestricted policies allow any host", () => {
    expect(
      isHostAllowedByNetworkPolicy({
        host: "anything.example.com",
        policy: null,
      }),
    ).toBe(true);
    expect(
      isHostAllowedByNetworkPolicy({
        host: "anything.example.com",
        policy: policy({ egressMode: "unrestricted" }),
      }),
    ).toBe(true);
  });

  test("off mode blocks every host", () => {
    expect(
      isHostAllowedByNetworkPolicy({
        host: "github.com",
        policy: policy({ egressMode: "off" }),
      }),
    ).toBe(false);
  });

  describe("restricted: exact domains", () => {
    const p = policy({ allowedDomains: ["allowed.example.com"] });

    test("allows an exact match (case-insensitive)", () => {
      expect(
        isHostAllowedByNetworkPolicy({
          host: "allowed.example.com",
          policy: p,
        }),
      ).toBe(true);
      expect(
        isHostAllowedByNetworkPolicy({
          host: "ALLOWED.Example.COM",
          policy: p,
        }),
      ).toBe(true);
      expect(
        isHostAllowedByNetworkPolicy({
          host: "allowed.example.com.",
          policy: p,
        }),
      ).toBe(true);
    });

    test("blocks a non-listed host", () => {
      expect(
        isHostAllowedByNetworkPolicy({ host: "other.example.com", policy: p }),
      ).toBe(false);
    });
  });

  describe("restricted: wildcard domains", () => {
    const p = policy({ allowedDomains: ["*.example.com"] });

    test("matches subdomains at any depth but not the apex", () => {
      expect(
        isHostAllowedByNetworkPolicy({ host: "api.example.com", policy: p }),
      ).toBe(true);
      expect(
        isHostAllowedByNetworkPolicy({ host: "a.b.example.com", policy: p }),
      ).toBe(true);
      expect(
        isHostAllowedByNetworkPolicy({ host: "example.com", policy: p }),
      ).toBe(false);
      expect(
        isHostAllowedByNetworkPolicy({ host: "notexample.com", policy: p }),
      ).toBe(false);
    });
  });

  describe("restricted: domain presets", () => {
    const p = policy({ domainPreset: "common_dependencies" });

    test("allows preset entries (exact and wildcard) and blocks others", () => {
      expect(
        isHostAllowedByNetworkPolicy({ host: "github.com", policy: p }),
      ).toBe(true);
      expect(
        isHostAllowedByNetworkPolicy({ host: "api.github.com", policy: p }),
      ).toBe(true);
      expect(
        isHostAllowedByNetworkPolicy({ host: "evil.com", policy: p }),
      ).toBe(false);
    });
  });

  describe("restricted: CIDR matching for IP-literal hosts", () => {
    test("matches IPv4 hosts inside an allowed CIDR", () => {
      const p = policy({ allowedCidrs: ["203.0.113.0/24"] });
      expect(
        isHostAllowedByNetworkPolicy({ host: "203.0.113.5", policy: p }),
      ).toBe(true);
      expect(
        isHostAllowedByNetworkPolicy({ host: "198.51.100.7", policy: p }),
      ).toBe(false);
    });

    test("matches bracketed IPv6 hosts inside an allowed CIDR", () => {
      const p = policy({ allowedCidrs: ["2001:db8::/32"] });
      expect(
        isHostAllowedByNetworkPolicy({ host: "[2001:db8::1]", policy: p }),
      ).toBe(true);
      expect(
        isHostAllowedByNetworkPolicy({ host: "[2001:db9::1]", policy: p }),
      ).toBe(false);
    });

    test("does not throw on IPv4-host vs IPv6-CIDR kind mismatch", () => {
      const p = policy({ allowedCidrs: ["2001:db8::/32"] });
      expect(
        isHostAllowedByNetworkPolicy({ host: "203.0.113.5", policy: p }),
      ).toBe(false);
    });

    test("an IP-literal host is not matched by domain rules", () => {
      const p = policy({ allowedDomains: ["203.0.113.5"], allowedCidrs: [] });
      expect(
        isHostAllowedByNetworkPolicy({ host: "203.0.113.5", policy: p }),
      ).toBe(false);
    });
  });
});
