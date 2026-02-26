import { createHash } from "node:crypto";
import { type Mock, vi } from "vitest";
import { beforeEach, describe, expect, test } from "@/test";
import {
  buildDiscoveryUrls,
  discoverScopes,
  generateCodeChallenge,
  generateCodeVerifier,
} from "./oauth";

describe("OAuth helper functions", () => {
  describe("generateCodeVerifier", () => {
    test("returns a base64url-encoded string", () => {
      const verifier = generateCodeVerifier();
      expect(verifier).toBeTruthy();
      // base64url uses only alphanumeric, - and _
      expect(verifier).toMatch(/^[A-Za-z0-9_-]+$/);
    });

    test("returns different values on each call", () => {
      const v1 = generateCodeVerifier();
      const v2 = generateCodeVerifier();
      expect(v1).not.toBe(v2);
    });

    test("has expected length for 32 random bytes", () => {
      const verifier = generateCodeVerifier();
      // 32 bytes -> 43 base64url chars (ceil(32 * 4/3))
      expect(verifier.length).toBe(43);
    });
  });

  describe("generateCodeChallenge", () => {
    test("returns SHA-256 hash as base64url", () => {
      const verifier = "test-verifier-string";
      const challenge = generateCodeChallenge(verifier);

      // Independently compute expected value
      const expected = createHash("sha256")
        .update(verifier)
        .digest("base64url");
      expect(challenge).toBe(expected);
    });

    test("produces consistent output for the same input", () => {
      const verifier = generateCodeVerifier();
      const c1 = generateCodeChallenge(verifier);
      const c2 = generateCodeChallenge(verifier);
      expect(c1).toBe(c2);
    });

    test("produces different output for different input", () => {
      const c1 = generateCodeChallenge("verifier-a");
      const c2 = generateCodeChallenge("verifier-b");
      expect(c1).not.toBe(c2);
    });
  });

  describe("buildDiscoveryUrls", () => {
    test("root URL returns OAuth and OIDC endpoints", () => {
      const urls = buildDiscoveryUrls("https://auth.example.com");
      expect(urls).toEqual([
        "https://auth.example.com/.well-known/oauth-authorization-server",
        "https://auth.example.com/.well-known/openid-configuration",
      ]);
    });

    test("root URL with trailing slash", () => {
      const urls = buildDiscoveryUrls("https://auth.example.com/");
      expect(urls).toEqual([
        "https://auth.example.com/.well-known/oauth-authorization-server",
        "https://auth.example.com/.well-known/openid-configuration",
      ]);
    });

    test("path-aware URL returns all fallback endpoints", () => {
      const urls = buildDiscoveryUrls("https://example.com/mcp");
      expect(urls).toEqual([
        "https://example.com/.well-known/oauth-authorization-server/mcp",
        "https://example.com/.well-known/oauth-authorization-server",
        "https://example.com/.well-known/openid-configuration/mcp",
        "https://example.com/mcp/.well-known/openid-configuration",
      ]);
    });

    test("path-aware URL with trailing slash strips it", () => {
      const urls = buildDiscoveryUrls("https://example.com/api/mcp/");
      expect(urls).toEqual([
        "https://example.com/.well-known/oauth-authorization-server/api/mcp",
        "https://example.com/.well-known/oauth-authorization-server",
        "https://example.com/.well-known/openid-configuration/api/mcp",
        "https://example.com/api/mcp/.well-known/openid-configuration",
      ]);
    });

    test("URL with port preserves it", () => {
      const urls = buildDiscoveryUrls("https://auth.example.com:8443");
      expect(urls).toEqual([
        "https://auth.example.com:8443/.well-known/oauth-authorization-server",
        "https://auth.example.com:8443/.well-known/openid-configuration",
      ]);
    });
  });

  describe("discoverScopes", () => {
    const originalFetch = globalThis.fetch;

    beforeEach(() => {
      vi.restoreAllMocks();
    });

    test("returns default scopes when discovery fails", async () => {
      // Mock fetch to always fail
      globalThis.fetch = vi.fn().mockRejectedValue(new Error("Network error"));

      const scopes = await discoverScopes("https://example.com", false, [
        "read",
        "write",
      ]);
      expect(scopes).toEqual(["read", "write"]);

      // Restore
      globalThis.fetch = originalFetch;
    });

    test("returns scopes from authorization server metadata", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          authorization_endpoint: "https://example.com/authorize",
          token_endpoint: "https://example.com/token",
          scopes_supported: ["openid", "profile", "email"],
        }),
      }) as Mock;

      const scopes = await discoverScopes("https://example.com", false, [
        "read",
        "write",
      ]);
      expect(scopes).toEqual(["openid", "profile", "email"]);

      globalThis.fetch = originalFetch;
    });

    test("tries resource metadata first when supports_resource_metadata is true", async () => {
      const fetchMock = vi
        .fn()
        // First call: resource metadata
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            scopes_supported: ["mcp:read", "mcp:write"],
          }),
        }) as Mock;

      globalThis.fetch = fetchMock;

      const scopes = await discoverScopes("https://example.com/mcp", true, [
        "read",
        "write",
      ]);
      expect(scopes).toEqual(["mcp:read", "mcp:write"]);
      // Should have called fetch only once (resource metadata succeeded)
      expect(fetchMock).toHaveBeenCalledTimes(1);

      globalThis.fetch = originalFetch;
    });

    test("falls back to auth server metadata when resource metadata fails", async () => {
      const fetchMock = vi
        .fn()
        // First call: resource metadata fails
        .mockRejectedValueOnce(new Error("404"))
        // Second call: auth server metadata
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            authorization_endpoint: "https://example.com/authorize",
            token_endpoint: "https://example.com/token",
            scopes_supported: ["api:read"],
          }),
        }) as Mock;

      globalThis.fetch = fetchMock;

      const scopes = await discoverScopes("https://example.com", true, [
        "read",
        "write",
      ]);
      expect(scopes).toEqual(["api:read"]);

      globalThis.fetch = originalFetch;
    });
  });
});
