import { createHash } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { type Mock, vi } from "vitest";
import { CacheKey, cacheManager } from "@/cache-manager";
import db, { schema } from "@/database";
import { secretManager } from "@/secrets-manager";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import { useRouteTestApp } from "@/test/route-test-app";
import oauthRoutes, {
  buildDiscoveryUrls,
  discoverOAuthEndpoints,
  discoverScopes,
  generateCodeChallenge,
  generateCodeVerifier,
  getOAuthResource,
  getOAuthResourceUrl,
  getOAuthTokenResource,
  refreshOAuthToken,
  resolveOAuthScopesForAuthorization,
} from "./oauth";
import { OAUTH_CALLBACK_PATH } from "./route-paths";

// Several tests below swap `globalThis.fetch` for a mock and restore it inline
// after their assertions. If an assertion throws, the inline restore is skipped
// and the mocked fetch leaks into whatever test file runs next in the worker.
// This top-level hook guarantees the real fetch is back after every test.
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

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

  describe("getOAuthResource", () => {
    test("prefers explicit resource over legacy audience and server URL", () => {
      expect(
        getOAuthResource({
          resource: "https://resource.example.com",
          audience: "api://legacy-audience",
          server_url: "https://mcp.example.com/mcp",
        }),
      ).toBe("https://resource.example.com");
    });

    test("falls back to audience before server URL", () => {
      expect(
        getOAuthResource({
          audience: "api://legacy-audience",
          server_url: "https://mcp.example.com/mcp",
        }),
      ).toBe("api://legacy-audience");
    });

    test("does not fall back to server URL for authorization-code resource indicators", () => {
      expect(
        getOAuthResource({
          server_url: "https://mcp.example.com/mcp",
        }),
      ).toBeUndefined();
    });

    test("returns undefined when no resource fields are configured", () => {
      expect(getOAuthResource({})).toBeUndefined();
    });

    test("parses api-scheme resource values for proxy token exchange", () => {
      const resourceUrl = getOAuthResourceUrl({
        resource: "api://downstream-client-id",
        server_url: "https://mcp.example.com/mcp",
      });

      expect(resourceUrl.protocol).toBe("api:");
      expect(resourceUrl.href).toBe("api://downstream-client-id");
    });

    test("uses URL-shaped audience values for proxy token exchange", () => {
      const resourceUrl = getOAuthResourceUrl({
        audience: "api://legacy-audience",
        server_url: "https://mcp.example.com/mcp",
      });

      expect(resourceUrl.href).toBe("api://legacy-audience");
    });

    test("falls back to server URL when legacy audience is not URL-shaped", () => {
      const resourceUrl = getOAuthResourceUrl({
        audience: "legacy-audience",
        server_url: "https://mcp.example.com/mcp",
      });

      expect(resourceUrl.href).toBe("https://mcp.example.com/mcp");
    });

    test("rejects invalid resource values for proxy token exchange", () => {
      expect(() =>
        getOAuthResourceUrl({
          resource: "downstream-client-id",
          server_url: "https://mcp.example.com/mcp",
        }),
      ).toThrow("Invalid OAuth resource URL");
    });

    test("uses only explicit resource indicators for token requests", () => {
      expect(
        getOAuthTokenResource({
          resource: "https://resource.example.com",
          audience: "api://legacy-audience",
        }),
      ).toBe("https://resource.example.com");

      expect(
        getOAuthTokenResource({
          audience: "api://legacy-audience",
        }),
      ).toBe("api://legacy-audience");

      expect(getOAuthTokenResource({})).toBeUndefined();
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

    test("uses explicit authorization server metadata URL override", async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          authorization_endpoint: "https://auth.example.com/authorize",
          token_endpoint: "https://auth.example.com/token",
          scopes_supported: ["jira:read"],
        }),
      }) as Mock;

      globalThis.fetch = fetchMock;

      const scopes = await discoverScopes(
        "https://tenant.example.com/rest/oauth2/latest/token",
        false,
        ["read", "write"],
        {
          authServerUrl: "https://auth.example.com",
          wellKnownUrl:
            "https://auth.example.com/.well-known/openid-configuration",
        },
      );

      expect(scopes).toEqual(["jira:read"]);
      expect(fetchMock).toHaveBeenCalledWith(
        "https://auth.example.com/.well-known/openid-configuration",
        expect.anything(),
      );

      globalThis.fetch = originalFetch;
    });

    test("uses explicit resource metadata URL override", async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          scopes_supported: ["mcp:read"],
        }),
      }) as Mock;

      globalThis.fetch = fetchMock;

      const scopes = await discoverScopes(
        "https://example.com/mcp",
        true,
        ["read", "write"],
        {
          resourceMetadataUrl:
            "https://metadata.example.com/.well-known/oauth-protected-resource/mcp",
        },
      );

      expect(scopes).toEqual(["mcp:read"]);
      expect(fetchMock).toHaveBeenCalledWith(
        "https://metadata.example.com/.well-known/oauth-protected-resource/mcp",
        expect.anything(),
      );

      globalThis.fetch = originalFetch;
    });

    test("skips default resource metadata discovery when auth server override is set", async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          authorization_endpoint: "https://auth.example.com/authorize",
          token_endpoint: "https://auth.example.com/token",
          scopes_supported: ["jira:read"],
        }),
      }) as Mock;

      globalThis.fetch = fetchMock;

      const scopes = await discoverScopes(
        "https://tenant.example.com/rest/oauth2/latest/token",
        true,
        ["read", "write"],
        {
          authServerUrl: "https://auth.example.com",
          wellKnownUrl:
            "https://auth.example.com/.well-known/openid-configuration",
        },
      );

      expect(scopes).toEqual(["jira:read"]);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock).toHaveBeenCalledWith(
        "https://auth.example.com/.well-known/openid-configuration",
        expect.anything(),
      );

      globalThis.fetch = originalFetch;
    });
  });

  describe("resolveOAuthScopesForAuthorization", () => {
    const originalFetch = globalThis.fetch;

    beforeEach(() => {
      vi.restoreAllMocks();
    });

    test("prefers explicitly configured scopes without running discovery", async () => {
      const fetchMock = vi.fn().mockRejectedValue(new Error("Network error"));
      globalThis.fetch = fetchMock;

      const result = await resolveOAuthScopesForAuthorization({
        oauthConfig: {
          server_url: "https://example.com",
          supports_resource_metadata: false,
          scopes: ["READ"],
          default_scopes: ["read", "write"],
        },
      });

      expect(result).toEqual({
        configuredScopes: ["READ"],
        discoveredScopes: [],
        scopesToUse: ["READ", "offline_access"],
      });
      expect(fetchMock).not.toHaveBeenCalled();

      globalThis.fetch = originalFetch;
    });

    test("uses discovered scopes when the catalog does not configure any", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          authorization_endpoint: "https://example.com/authorize",
          token_endpoint: "https://example.com/token",
          scopes_supported: ["jira:read"],
        }),
      }) as Mock;

      const result = await resolveOAuthScopesForAuthorization({
        oauthConfig: {
          server_url: "https://example.com",
          supports_resource_metadata: false,
          scopes: [],
          default_scopes: ["read", "write"],
        },
      });

      expect(result).toEqual({
        configuredScopes: [],
        discoveredScopes: ["jira:read"],
        scopesToUse: ["jira:read", "offline_access"],
      });

      globalThis.fetch = originalFetch;
    });

    test("uses discovered scopes when the catalog leaves scopes undefined", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          authorization_endpoint: "https://example.com/authorize",
          token_endpoint: "https://example.com/token",
          scopes_supported: ["jira:write"],
        }),
      }) as Mock;

      const result = await resolveOAuthScopesForAuthorization({
        oauthConfig: {
          server_url: "https://example.com",
          supports_resource_metadata: false,
          default_scopes: ["read", "write"],
        },
      });

      expect(result).toEqual({
        configuredScopes: [],
        discoveredScopes: ["jira:write"],
        scopesToUse: ["jira:write", "offline_access"],
      });

      globalThis.fetch = originalFetch;
    });

    test("requests no scopes at all when none are configured and none are discovered", async () => {
      const fetchMock = vi.fn().mockRejectedValue(new Error("Network error"));
      globalThis.fetch = fetchMock;

      const result = await resolveOAuthScopesForAuthorization({
        oauthConfig: {
          server_url: "https://example.com",
          supports_resource_metadata: false,
          scopes: [],
          default_scopes: [],
        },
      });

      // Nothing to append `offline_access` on top of: asking for it alone
      // would request a token with no API scopes rather than letting the
      // server apply the client's own default scope set.
      expect(result).toEqual({
        configuredScopes: [],
        discoveredScopes: [],
        scopesToUse: [],
      });

      globalThis.fetch = originalFetch;
    });

    test("omits offline_access when additional_scopes is empty", async () => {
      const fetchMock = vi.fn().mockRejectedValue(new Error("Network error"));
      globalThis.fetch = fetchMock;

      const result = await resolveOAuthScopesForAuthorization({
        oauthConfig: {
          server_url: "https://accounts.google.com",
          supports_resource_metadata: false,
          scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
          additional_scopes: [],
        },
      });

      expect(result.scopesToUse).toEqual([
        "https://www.googleapis.com/auth/gmail.readonly",
      ]);
      expect(fetchMock).not.toHaveBeenCalled();

      globalThis.fetch = originalFetch;
    });

    test("appends configured additional_scopes verbatim", async () => {
      const fetchMock = vi.fn().mockRejectedValue(new Error("Network error"));
      globalThis.fetch = fetchMock;

      const result = await resolveOAuthScopesForAuthorization({
        oauthConfig: {
          server_url: "https://example.com",
          supports_resource_metadata: false,
          scopes: ["read"],
          additional_scopes: ["offline_access", "custom:scope"],
        },
      });

      expect(result.scopesToUse).toEqual([
        "read",
        "offline_access",
        "custom:scope",
      ]);

      globalThis.fetch = originalFetch;
    });

    test("does not duplicate a scope already present", async () => {
      const fetchMock = vi.fn().mockRejectedValue(new Error("Network error"));
      globalThis.fetch = fetchMock;

      const result = await resolveOAuthScopesForAuthorization({
        oauthConfig: {
          server_url: "https://example.com",
          supports_resource_metadata: false,
          scopes: ["read", "offline_access"],
        },
      });

      expect(result.scopesToUse).toEqual(["read", "offline_access"]);

      globalThis.fetch = originalFetch;
    });
  });

  describe("discoverOAuthEndpoints", () => {
    const originalFetch = globalThis.fetch;

    beforeEach(() => {
      vi.restoreAllMocks();
    });

    test("skips default resource metadata discovery when auth server override is set", async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          authorization_endpoint: "https://auth.example.com/authorize",
          token_endpoint: "https://auth.example.com/token",
        }),
      }) as Mock;

      globalThis.fetch = fetchMock;

      const endpoints = await discoverOAuthEndpoints({
        server_url: "https://tenant.example.com/rest/oauth2/latest/token",
        supports_resource_metadata: true,
        auth_server_url: "https://auth.example.com",
        well_known_url:
          "https://auth.example.com/.well-known/openid-configuration",
      });

      expect(endpoints).toEqual({
        authorizationEndpoint: "https://auth.example.com/authorize",
        tokenEndpoint: "https://auth.example.com/token",
        registrationEndpoint: undefined,
        // Carried out of discovery for the RFC 9207 issuer check. This
        // metadata declares neither, so there is nothing to record and the
        // server has not advertised iss support.
        issuer: undefined,
        issParameterSupported: false,
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock).toHaveBeenCalledWith(
        "https://auth.example.com/.well-known/openid-configuration",
        expect.anything(),
      );

      globalThis.fetch = originalFetch;
    });

    test("falls back to root protected resource metadata when the path-aware document is missing", async () => {
      const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (
          url ===
          "https://mcp.example.com/.well-known/oauth-protected-resource/mcp"
        ) {
          return { ok: false, status: 404 };
        }
        if (
          url === "https://mcp.example.com/.well-known/oauth-protected-resource"
        ) {
          return {
            ok: true,
            json: async () => ({
              resource: "https://mcp.example.com",
              authorization_servers: ["https://auth.example.com"],
            }),
          };
        }
        if (
          url ===
          "https://auth.example.com/.well-known/oauth-authorization-server"
        ) {
          return {
            ok: true,
            json: async () => ({
              authorization_endpoint:
                "https://auth.example.com/oauth2/authorize",
              token_endpoint: "https://auth.example.com/oauth2/token",
            }),
          };
        }
        return { ok: false, status: 404 };
      }) as Mock;

      globalThis.fetch = fetchMock;

      const endpoints = await discoverOAuthEndpoints({
        server_url: "https://mcp.example.com/mcp",
        supports_resource_metadata: true,
      });

      expect(endpoints.authorizationEndpoint).toBe(
        "https://auth.example.com/oauth2/authorize",
      );
      expect(endpoints.tokenEndpoint).toBe(
        "https://auth.example.com/oauth2/token",
      );
      // The path-aware document is tried first; the root document is the fallback
      // that hands discovery over to the advertised authorization server.
      expect(fetchMock.mock.calls.map((call) => String(call[0]))).toEqual([
        "https://mcp.example.com/.well-known/oauth-protected-resource/mcp",
        "https://mcp.example.com/.well-known/oauth-protected-resource",
        "https://auth.example.com/.well-known/oauth-authorization-server",
      ]);

      globalThis.fetch = originalFetch;
    });

    test("falls back to explicit endpoints when discovery fails", async () => {
      globalThis.fetch = vi.fn().mockRejectedValue(new Error("404")) as Mock;

      const endpoints = await discoverOAuthEndpoints({
        server_url: "https://legacy-idp.example.com/mcp",
        supports_resource_metadata: false,
        authorization_endpoint:
          "https://legacy-idp.example.com/oauth/authorize",
        token_endpoint: "https://legacy-idp.example.com/oauth/token",
      });

      expect(endpoints).toEqual({
        authorizationEndpoint: "https://legacy-idp.example.com/oauth/authorize",
        tokenEndpoint: "https://legacy-idp.example.com/oauth/token",
        registrationEndpoint: undefined,
      });

      globalThis.fetch = originalFetch;
    });

    test("throws when discovery fails and only one explicit endpoint is configured", async () => {
      globalThis.fetch = vi.fn().mockRejectedValue(new Error("404")) as Mock;

      await expect(
        discoverOAuthEndpoints({
          server_url: "https://legacy-idp.example.com/mcp",
          supports_resource_metadata: false,
          authorization_endpoint:
            "https://legacy-idp.example.com/oauth/authorize",
        }),
      ).rejects.toThrow("404");

      globalThis.fetch = originalFetch;
    });

    test("prefers explicit endpoints over discovered metadata", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          authorization_endpoint: "https://auth.example.com/authorize",
          token_endpoint: "https://auth.example.com/token",
          registration_endpoint: "https://auth.example.com/register",
        }),
      }) as Mock;

      const endpoints = await discoverOAuthEndpoints({
        server_url: "https://mcp.example.com",
        supports_resource_metadata: false,
        authorization_endpoint:
          "https://legacy-idp.example.com/oauth/authorize",
        token_endpoint: "https://legacy-idp.example.com/oauth/token",
      });

      expect(endpoints).toEqual({
        authorizationEndpoint: "https://legacy-idp.example.com/oauth/authorize",
        tokenEndpoint: "https://legacy-idp.example.com/oauth/token",
        registrationEndpoint: "https://auth.example.com/register",
        issuer: undefined,
        issParameterSupported: false,
      });

      globalThis.fetch = originalFetch;
    });
  });
});

describe("OAuth routes", () => {
  let app: FastifyInstanceWithZod;
  const originalFetch = globalThis.fetch;

  beforeEach(async () => {
    cacheManager.start();
    app = createFastifyInstance();
    await app.register(oauthRoutes);
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
    await app.close();
  });

  test("rejects an invalid callback state before token exchange", async () => {
    const response = await app.inject({
      method: "POST",
      url: OAUTH_CALLBACK_PATH,
      payload: { code: "fake-code", state: "invalid-state" },
    });

    expect(response.statusCode, response.body).toBe(400);
    expect(response.json().error.message).toContain(
      "Invalid or expired OAuth state",
    );
  });

  test("uses a configured OAuth resource separately from the MCP endpoint URL", async ({
    makeInternalMcpCatalog,
  }) => {
    const catalog = await makeInternalMcpCatalog({
      name: "Resource Split MCP",
      serverType: "remote",
      serverUrl: "https://mcp.example.com/mcp",
      oauthConfig: {
        name: "Resource Split MCP",
        server_url: "https://mcp.example.com/mcp",
        resource: "https://mcp.example.com",
        grant_type: "authorization_code",
        auth_server_url: "https://login.example.com/tenant/v2.0",
        authorization_endpoint:
          "https://login.example.com/tenant/oauth2/v2.0/authorize",
        token_endpoint: "https://login.example.com/tenant/oauth2/v2.0/token",
        client_id: "public-client-id",
        redirect_uris: ["http://localhost:3000/oauth-callback"],
        scopes: ["api://downstream-app/Tools.Read"],
        default_scopes: ["api://downstream-app/Tools.Read"],
        supports_resource_metadata: false,
      },
    });

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        authorization_endpoint:
          "https://login.example.com/tenant/oauth2/v2.0/authorize",
        token_endpoint: "https://login.example.com/tenant/oauth2/v2.0/token",
      }),
    }) as Mock;

    const response = await app.inject({
      method: "POST",
      url: "/api/oauth/initiate",
      payload: {
        catalogId: catalog.id,
      },
    });

    expect(response.statusCode, response.body).toBe(200);
    const authorizationUrl = new URL(response.json().authorizationUrl);
    expect(authorizationUrl.searchParams.get("resource")).toBe(
      "https://mcp.example.com",
    );
    expect(authorizationUrl.searchParams.get("resource")).not.toBe(
      "https://mcp.example.com/mcp",
    );
  });

  test("does not send the MCP endpoint URL as a token resource during callback", async ({
    makeInternalMcpCatalog,
  }) => {
    const catalog = await makeInternalMcpCatalog({
      name: "Direct OAuth MCP",
      serverType: "remote",
      serverUrl: "https://mcp.example.com/v1/mcp",
      oauthConfig: {
        name: "Direct OAuth MCP",
        server_url: "https://mcp.example.com/v1/mcp",
        grant_type: "authorization_code",
        auth_server_url: "https://login.example.com/oauth",
        authorization_endpoint: "https://login.example.com/oauth/authorize",
        token_endpoint: "https://login.example.com/oauth/token",
        client_id: "public-client-id",
        client_secret: "public-client-secret",
        redirect_uris: ["http://localhost:3000/oauth-callback"],
        scopes: ["read", "write"],
        default_scopes: ["read", "write"],
        supports_resource_metadata: false,
      },
    });

    const fetchMock = vi.fn(async (input, init) => {
      const url = String(input);

      if (url === "https://login.example.com/oauth/token") {
        const body = init?.body as URLSearchParams;
        if (body.has("resource")) {
          return {
            ok: false,
            status: 400,
            text: async () =>
              JSON.stringify({
                error: "invalid_target",
                error_description: "Incorrect resource parameters",
              }),
          };
        }

        return {
          ok: true,
          status: 200,
          json: async () => ({
            access_token: "new-access-token",
            refresh_token: "new-refresh-token",
            expires_in: 3600,
          }),
          text: async () =>
            JSON.stringify({
              access_token: "new-access-token",
              refresh_token: "new-refresh-token",
              expires_in: 3600,
            }),
        };
      }

      return {
        ok: true,
        json: async () => ({
          authorization_endpoint: "https://login.example.com/oauth/authorize",
          token_endpoint: "https://login.example.com/oauth/token",
        }),
      };
    }) as Mock;
    globalThis.fetch = fetchMock;

    const initiateResponse = await app.inject({
      method: "POST",
      url: "/api/oauth/initiate",
      payload: {
        catalogId: catalog.id,
      },
    });
    expect(initiateResponse.statusCode, initiateResponse.body).toBe(200);
    const authorizationUrl = new URL(initiateResponse.json().authorizationUrl);
    expect(authorizationUrl.searchParams.has("resource")).toBe(false);
    const state = initiateResponse.json().state;

    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS keyv_cache (
        key text PRIMARY KEY,
        value text NOT NULL
      )
    `);
    await db.execute(sql`
      INSERT INTO keyv_cache (key, value)
      VALUES (
        ${`keyv:${CacheKey.OAuthState}-${state}`},
        ${JSON.stringify({
          value: {
            catalogId: catalog.id,
            codeVerifier: "test-code-verifier",
            clientId: "public-client-id",
            clientSecret: "public-client-secret",
          },
          expires: Date.now() + 60_000,
        })}
      )
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
    `);

    const callbackResponse = await app.inject({
      method: "POST",
      url: "/api/oauth/callback",
      payload: {
        code: "authorization-code",
        state,
      },
    });

    expect(callbackResponse.statusCode, callbackResponse.body).toBe(200);
    expect(callbackResponse.json()).toMatchObject({
      success: true,
      catalogId: catalog.id,
      accessToken: "new-access-token",
      refreshToken: "new-refresh-token",
    });

    const tokenRequest = fetchMock.mock.calls.find(
      ([input]) => String(input) === "https://login.example.com/oauth/token",
    );
    const requestBody = tokenRequest?.[1]?.body as URLSearchParams;
    expect(requestBody.get("grant_type")).toBe("authorization_code");
    expect(requestBody.get("code")).toBe("authorization-code");
    expect(requestBody.has("resource")).toBe(false);
  });
  test("forwards a matching iss through the callback (RFC 9207)", async ({
    makeInternalMcpCatalog,
  }) => {
    const catalog = await makeInternalMcpCatalog({
      name: "Direct OAuth MCP",
      serverType: "remote",
      serverUrl: "https://mcp.example.com/v1/mcp",
      oauthConfig: {
        name: "Direct OAuth MCP",
        server_url: "https://mcp.example.com/v1/mcp",
        grant_type: "authorization_code",
        auth_server_url: "https://login.example.com/oauth",
        authorization_endpoint: "https://login.example.com/oauth/authorize",
        token_endpoint: "https://login.example.com/oauth/token",
        client_id: "public-client-id",
        client_secret: "public-client-secret",
        redirect_uris: ["http://localhost:3000/oauth-callback"],
        scopes: ["read", "write"],
        default_scopes: ["read", "write"],
        supports_resource_metadata: false,
      },
    });

    const fetchMock = vi.fn(async (input, init) => {
      const url = String(input);

      if (url === "https://login.example.com/oauth/token") {
        const body = init?.body as URLSearchParams;
        if (body.has("resource")) {
          return {
            ok: false,
            status: 400,
            text: async () =>
              JSON.stringify({
                error: "invalid_target",
                error_description: "Incorrect resource parameters",
              }),
          };
        }

        return {
          ok: true,
          status: 200,
          json: async () => ({
            access_token: "new-access-token",
            refresh_token: "new-refresh-token",
            expires_in: 3600,
          }),
          text: async () =>
            JSON.stringify({
              access_token: "new-access-token",
              refresh_token: "new-refresh-token",
              expires_in: 3600,
            }),
        };
      }

      return {
        ok: true,
        json: async () => ({
          authorization_endpoint: "https://login.example.com/oauth/authorize",
          token_endpoint: "https://login.example.com/oauth/token",
        }),
      };
    }) as Mock;
    globalThis.fetch = fetchMock;

    const initiateResponse = await app.inject({
      method: "POST",
      url: "/api/oauth/initiate",
      payload: {
        catalogId: catalog.id,
      },
    });
    expect(initiateResponse.statusCode, initiateResponse.body).toBe(200);
    const authorizationUrl = new URL(initiateResponse.json().authorizationUrl);
    expect(authorizationUrl.searchParams.has("resource")).toBe(false);
    const state = initiateResponse.json().state;

    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS keyv_cache (
        key text PRIMARY KEY,
        value text NOT NULL
      )
    `);
    await db.execute(sql`
      INSERT INTO keyv_cache (key, value)
      VALUES (
        ${`keyv:${CacheKey.OAuthState}-${state}`},
        ${JSON.stringify({
          value: {
            catalogId: catalog.id,
            codeVerifier: "test-code-verifier",
            clientId: "public-client-id",
            clientSecret: "public-client-secret",
            issuer: "https://login.example.com",
            issParameterSupported: true,
          },
          expires: Date.now() + 60_000,
        })}
      )
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
    `);

    const callbackResponse = await app.inject({
      method: "POST",
      url: "/api/oauth/callback",
      payload: {
        code: "authorization-code",
        state,
        iss: "https://login.example.com",
      },
    });

    // Regression: the browser must forward `iss`. When it did not, a server
    // advertising RFC 9207 support had every flow rejected for its absence.
    expect(callbackResponse.statusCode, callbackResponse.body).toBe(200);
  });

  test("rejects a callback whose iss is not the server the flow started with", async ({
    makeInternalMcpCatalog,
  }) => {
    const catalog = await makeInternalMcpCatalog({
      name: "Direct OAuth MCP",
      serverType: "remote",
      serverUrl: "https://mcp.example.com/v1/mcp",
      oauthConfig: {
        name: "Direct OAuth MCP",
        server_url: "https://mcp.example.com/v1/mcp",
        grant_type: "authorization_code",
        auth_server_url: "https://login.example.com/oauth",
        authorization_endpoint: "https://login.example.com/oauth/authorize",
        token_endpoint: "https://login.example.com/oauth/token",
        client_id: "public-client-id",
        client_secret: "public-client-secret",
        redirect_uris: ["http://localhost:3000/oauth-callback"],
        scopes: ["read", "write"],
        default_scopes: ["read", "write"],
        supports_resource_metadata: false,
      },
    });

    const fetchMock = vi.fn(async (input, init) => {
      const url = String(input);

      if (url === "https://login.example.com/oauth/token") {
        const body = init?.body as URLSearchParams;
        if (body.has("resource")) {
          return {
            ok: false,
            status: 400,
            text: async () =>
              JSON.stringify({
                error: "invalid_target",
                error_description: "Incorrect resource parameters",
              }),
          };
        }

        return {
          ok: true,
          status: 200,
          json: async () => ({
            access_token: "new-access-token",
            refresh_token: "new-refresh-token",
            expires_in: 3600,
          }),
          text: async () =>
            JSON.stringify({
              access_token: "new-access-token",
              refresh_token: "new-refresh-token",
              expires_in: 3600,
            }),
        };
      }

      return {
        ok: true,
        json: async () => ({
          authorization_endpoint: "https://login.example.com/oauth/authorize",
          token_endpoint: "https://login.example.com/oauth/token",
        }),
      };
    }) as Mock;
    globalThis.fetch = fetchMock;

    const initiateResponse = await app.inject({
      method: "POST",
      url: "/api/oauth/initiate",
      payload: {
        catalogId: catalog.id,
      },
    });
    expect(initiateResponse.statusCode, initiateResponse.body).toBe(200);
    const authorizationUrl = new URL(initiateResponse.json().authorizationUrl);
    expect(authorizationUrl.searchParams.has("resource")).toBe(false);
    const state = initiateResponse.json().state;

    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS keyv_cache (
        key text PRIMARY KEY,
        value text NOT NULL
      )
    `);
    await db.execute(sql`
      INSERT INTO keyv_cache (key, value)
      VALUES (
        ${`keyv:${CacheKey.OAuthState}-${state}`},
        ${JSON.stringify({
          value: {
            catalogId: catalog.id,
            codeVerifier: "test-code-verifier",
            clientId: "public-client-id",
            clientSecret: "public-client-secret",
            issuer: "https://login.example.com",
            issParameterSupported: true,
          },
          expires: Date.now() + 60_000,
        })}
      )
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
    `);

    const callbackResponse = await app.inject({
      method: "POST",
      url: "/api/oauth/callback",
      payload: {
        code: "authorization-code",
        state,
        iss: "https://evil.example.com",
      },
    });

    expect(callbackResponse.statusCode).toBe(400);
    expect(callbackResponse.body).toContain("issuer");
  });

  test("includes configured OAuth resource when refreshing access tokens", async ({
    makeInternalMcpCatalog,
  }) => {
    const catalog = await makeInternalMcpCatalog({
      name: "Refresh Resource Split MCP",
      serverType: "remote",
      serverUrl: "https://mcp.example.com/mcp",
      oauthConfig: {
        name: "Refresh Resource Split MCP",
        server_url: "https://mcp.example.com/mcp",
        resource: "https://mcp.example.com",
        grant_type: "authorization_code",
        auth_server_url: "https://login.example.com/tenant/v2.0",
        authorization_endpoint:
          "https://login.example.com/tenant/oauth2/v2.0/authorize",
        token_endpoint: "https://login.example.com/tenant/oauth2/v2.0/token",
        client_id: "public-client-id",
        client_secret: "public-client-secret",
        redirect_uris: ["http://localhost:3000/oauth-callback"],
        scopes: ["api://downstream-app/Tools.Read"],
        default_scopes: ["api://downstream-app/Tools.Read"],
        supports_resource_metadata: false,
      },
    });
    const secret = await secretManager().createSecret(
      {
        refresh_token: "stored-refresh-token",
        access_token: "old-access-token",
      },
      "refresh-resource-token",
      true,
    );

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          access_token: "new-access-token",
          refresh_token: "new-refresh-token",
          expires_in: 3600,
        }),
    }) as Mock;
    globalThis.fetch = fetchMock;

    await expect(refreshOAuthToken(secret.id, catalog.id)).resolves.toEqual({
      ok: true,
    });

    const requestBody = fetchMock.mock.calls.at(-1)?.[1]
      ?.body as URLSearchParams;
    expect(requestBody.get("grant_type")).toBe("refresh_token");
    expect(requestBody.get("refresh_token")).toBe("stored-refresh-token");
    expect(requestBody.get("resource")).toBe("https://mcp.example.com");
  });

  test("returns a terminal failure when the refreshed token cannot be persisted", async ({
    makeInternalMcpCatalog,
  }) => {
    const catalog = await makeInternalMcpCatalog({
      name: "Persist Failure MCP",
      serverType: "remote",
      serverUrl: "https://mcp.example.com/mcp",
      oauthConfig: {
        name: "Persist Failure MCP",
        server_url: "https://mcp.example.com/mcp",
        grant_type: "authorization_code",
        token_endpoint: "https://login.example.com/token",
        client_id: "public-client-id",
        redirect_uris: ["http://localhost:3000/oauth-callback"],
        scopes: [],
        default_scopes: [],
        supports_resource_metadata: false,
      },
    });
    const secret = await secretManager().createSecret(
      {
        refresh_token: "stored-refresh-token",
        access_token: "old-access-token",
      },
      "persist-failure-token",
      true,
    );

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          access_token: "rotated-access-token",
          refresh_token: "rotated-refresh-token",
          expires_in: 3600,
        }),
    }) as Mock;

    // A rotating server has spent the old refresh token; losing the new one to
    // a persistence failure must force re-authentication, not a silent retry.
    const updateSpy = vi
      .spyOn(secretManager(), "updateSecret")
      .mockRejectedValueOnce(new Error("vault unavailable"));

    await expect(refreshOAuthToken(secret.id, catalog.id)).resolves.toEqual({
      ok: false,
      kind: "terminal",
      category: "refresh_failed",
      message: "refresh_failed",
    });

    updateSpy.mockRestore();
  });

  test("a 400 invalid_grant is a terminal failure and persists no token", async ({
    makeInternalMcpCatalog,
  }) => {
    const catalog = await makeInternalMcpCatalog({
      name: "Invalid Grant MCP",
      serverType: "remote",
      serverUrl: "https://mcp.example.com/mcp",
      oauthConfig: {
        name: "Invalid Grant MCP",
        server_url: "https://mcp.example.com/mcp",
        grant_type: "authorization_code",
        token_endpoint: "https://login.example.com/token",
        client_id: "public-client-id",
        redirect_uris: ["http://localhost:3000/oauth-callback"],
        scopes: [],
        default_scopes: [],
        supports_resource_metadata: false,
      },
    });
    const secret = await secretManager().createSecret(
      {
        refresh_token: "stored-refresh-token",
        access_token: "old-access-token",
      },
      "invalid-grant-token",
      true,
    );

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      text: async () =>
        JSON.stringify({
          error: "invalid_grant",
          error_description: "Token expired or revoked",
        }),
    }) as Mock;
    const updateSpy = vi.spyOn(secretManager(), "updateSecret");

    await expect(refreshOAuthToken(secret.id, catalog.id)).resolves.toEqual({
      ok: false,
      kind: "terminal",
      category: "refresh_failed",
      message: "invalid_grant",
      description: "Token expired or revoked",
    });
    // A rejected grant must not write a token; re-authentication is required.
    expect(updateSpy).not.toHaveBeenCalled();

    updateSpy.mockRestore();
  });

  test("returns a terminal no_refresh_token failure when the secret has no refresh token", async ({
    makeInternalMcpCatalog,
  }) => {
    const catalog = await makeInternalMcpCatalog({
      name: "No Refresh Token MCP",
      serverType: "remote",
      serverUrl: "https://mcp.example.com/mcp",
      oauthConfig: {
        name: "No Refresh Token MCP",
        server_url: "https://mcp.example.com/mcp",
        grant_type: "authorization_code",
        token_endpoint: "https://login.example.com/token",
        client_id: "public-client-id",
        redirect_uris: ["http://localhost:3000/oauth-callback"],
        scopes: [],
        default_scopes: [],
        supports_resource_metadata: false,
      },
    });
    const secret = await secretManager().createSecret(
      { access_token: "only-access-token" },
      "no-refresh-token-secret",
      true,
    );

    await expect(refreshOAuthToken(secret.id, catalog.id)).resolves.toEqual({
      ok: false,
      kind: "terminal",
      category: "no_refresh_token",
      message: "no_refresh_token",
    });
  });

  test("returns a terminal refresh_failed when the secret cannot be found", async ({
    makeInternalMcpCatalog,
  }) => {
    const catalog = await makeInternalMcpCatalog({
      name: "Missing Secret MCP",
      serverType: "remote",
      serverUrl: "https://mcp.example.com/mcp",
      oauthConfig: {
        name: "Missing Secret MCP",
        server_url: "https://mcp.example.com/mcp",
        grant_type: "authorization_code",
        token_endpoint: "https://login.example.com/token",
        client_id: "public-client-id",
        redirect_uris: ["http://localhost:3000/oauth-callback"],
        scopes: [],
        default_scopes: [],
        supports_resource_metadata: false,
      },
    });

    await expect(
      refreshOAuthToken("00000000-0000-0000-0000-000000000000", catalog.id),
    ).resolves.toEqual({
      ok: false,
      kind: "terminal",
      category: "refresh_failed",
      message: "refresh_failed",
    });
  });

  test("does not send the MCP endpoint URL as a token resource during refresh", async ({
    makeInternalMcpCatalog,
  }) => {
    const catalog = await makeInternalMcpCatalog({
      name: "Refresh Direct OAuth MCP",
      serverType: "remote",
      serverUrl: "https://mcp.example.com/v1/mcp",
      oauthConfig: {
        name: "Refresh Direct OAuth MCP",
        server_url: "https://mcp.example.com/v1/mcp",
        grant_type: "authorization_code",
        auth_server_url: "https://login.example.com/oauth",
        authorization_endpoint: "https://login.example.com/oauth/authorize",
        token_endpoint: "https://login.example.com/oauth/token",
        client_id: "public-client-id",
        client_secret: "public-client-secret",
        redirect_uris: ["http://localhost:3000/oauth-callback"],
        scopes: ["read", "write"],
        default_scopes: ["read", "write"],
        supports_resource_metadata: false,
      },
    });
    const secret = await secretManager().createSecret(
      {
        refresh_token: "stored-refresh-token",
        access_token: "old-access-token",
      },
      "refresh-direct-token",
      true,
    );

    const fetchMock = vi.fn(async (input, init) => {
      const url = String(input);

      if (url === "https://login.example.com/oauth/token") {
        const body = init?.body as URLSearchParams;
        if (body.has("resource")) {
          return {
            ok: false,
            status: 400,
            text: async () =>
              JSON.stringify({
                error: "invalid_target",
                error_description: "Incorrect resource parameters",
              }),
          };
        }

        return {
          ok: true,
          status: 200,
          json: async () => ({
            access_token: "new-access-token",
            refresh_token: "new-refresh-token",
            expires_in: 3600,
          }),
          text: async () =>
            JSON.stringify({
              access_token: "new-access-token",
              refresh_token: "new-refresh-token",
              expires_in: 3600,
            }),
        };
      }

      return {
        ok: true,
        json: async () => ({
          authorization_endpoint: "https://login.example.com/oauth/authorize",
          token_endpoint: "https://login.example.com/oauth/token",
        }),
      };
    }) as Mock;
    globalThis.fetch = fetchMock;

    await expect(refreshOAuthToken(secret.id, catalog.id)).resolves.toEqual({
      ok: true,
    });

    const tokenRequest = fetchMock.mock.calls.find(
      ([input]) => String(input) === "https://login.example.com/oauth/token",
    );
    const requestBody = tokenRequest?.[1]?.body as URLSearchParams;
    expect(requestBody.get("grant_type")).toBe("refresh_token");
    expect(requestBody.get("refresh_token")).toBe("stored-refresh-token");
    expect(requestBody.has("resource")).toBe(false);
  });
});

describe("OAuth dynamic client registration client name", () => {
  // Stubs an authenticated request context so request.organizationId resolves
  // to a fresh org per test, which the brand-name resolution reads under
  // white-labeling.
  const ctx = useRouteTestApp(oauthRoutes);
  const originalFetch = globalThis.fetch;
  const REGISTRATION_ENDPOINT = "https://auth.example.com/register";

  beforeEach(() => {
    cacheManager.start();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  // Every non-registration request resolves auth-server metadata advertising a
  // registration endpoint; the registration POST returns a freshly issued
  // client id. Returns the mock so the test can read back the client metadata
  // that was sent.
  const mockRegistrationFlow = (): Mock => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === REGISTRATION_ENDPOINT) {
        return {
          ok: true,
          json: async () => ({ client_id: "registered-client-id" }),
        };
      }
      return {
        ok: true,
        json: async () => ({
          authorization_endpoint: "https://auth.example.com/authorize",
          token_endpoint: "https://auth.example.com/token",
          registration_endpoint: REGISTRATION_ENDPOINT,
        }),
      };
    }) as Mock;
    globalThis.fetch = fetchMock;
    return fetchMock;
  };

  const readRegisteredClientName = (fetchMock: Mock): string => {
    const registrationCall = fetchMock.mock.calls.find(
      ([input]) => String(input) === REGISTRATION_ENDPOINT,
    );
    return JSON.parse(String(registrationCall?.[1]?.body)).client_name;
  };

  // A catalog item without a client_id, so the initiate flow performs dynamic
  // client registration (which is where the consent-screen client name is set).
  const makeDcrCatalog = (
    makeInternalMcpCatalog: (
      overrides?: Record<string, unknown>,
    ) => Promise<{ id: string; name: string }>,
    name: string,
  ) =>
    makeInternalMcpCatalog({
      organizationId: ctx.organizationId,
      name,
      serverType: "remote",
      serverUrl: "https://mcp.example.com/mcp",
      oauthConfig: {
        name,
        server_url: "https://mcp.example.com/mcp",
        grant_type: "authorization_code",
        client_id: "",
        redirect_uris: ["http://localhost:3000/oauth-callback"],
        scopes: ["read"],
        default_scopes: ["read"],
        supports_resource_metadata: false,
      },
    });

  test("ignores the org app name and uses the default brand when full white-labeling is off", async ({
    makeInternalMcpCatalog,
  }) => {
    const config = (await import("@/config")).default;
    const original = config.enterpriseFeatures.fullWhiteLabeling;
    (
      config.enterpriseFeatures as { fullWhiteLabeling: boolean }
    ).fullWhiteLabeling = false;
    // App name is set, but without the white-labeling license it must not leak
    // into the consent screen.
    await db
      .update(schema.organizationsTable)
      .set({ appName: "Contoso Copilot" })
      .where(eq(schema.organizationsTable.id, ctx.organizationId));

    try {
      const catalog = await makeDcrCatalog(
        makeInternalMcpCatalog,
        "Acme Cloud",
      );
      const fetchMock = mockRegistrationFlow();

      const response = await ctx.app.inject({
        method: "POST",
        url: "/api/oauth/initiate",
        payload: { catalogId: catalog.id },
      });

      expect(response.statusCode, response.body).toBe(200);
      expect(readRegisteredClientName(fetchMock)).toBe(
        "Archestra Platform - Acme Cloud",
      );
    } finally {
      (
        config.enterpriseFeatures as { fullWhiteLabeling: boolean }
      ).fullWhiteLabeling = original;
    }
  });

  test("uses the organization's white-label app name when full white-labeling is on", async ({
    makeInternalMcpCatalog,
  }) => {
    const config = (await import("@/config")).default;
    const original = config.enterpriseFeatures.fullWhiteLabeling;
    (
      config.enterpriseFeatures as { fullWhiteLabeling: boolean }
    ).fullWhiteLabeling = true;
    await db
      .update(schema.organizationsTable)
      .set({ appName: "Contoso Copilot" })
      .where(eq(schema.organizationsTable.id, ctx.organizationId));

    try {
      const catalog = await makeDcrCatalog(
        makeInternalMcpCatalog,
        "Acme Cloud",
      );
      const fetchMock = mockRegistrationFlow();

      const response = await ctx.app.inject({
        method: "POST",
        url: "/api/oauth/initiate",
        payload: { catalogId: catalog.id },
      });

      expect(response.statusCode, response.body).toBe(200);
      expect(readRegisteredClientName(fetchMock)).toBe(
        "Contoso Copilot - Acme Cloud",
      );
    } finally {
      (
        config.enterpriseFeatures as { fullWhiteLabeling: boolean }
      ).fullWhiteLabeling = original;
    }
  });

  test("falls back to the default brand when white-labeling is on but no app name is set", async ({
    makeInternalMcpCatalog,
  }) => {
    const config = (await import("@/config")).default;
    const original = config.enterpriseFeatures.fullWhiteLabeling;
    (
      config.enterpriseFeatures as { fullWhiteLabeling: boolean }
    ).fullWhiteLabeling = true;

    try {
      const catalog = await makeDcrCatalog(
        makeInternalMcpCatalog,
        "Acme Cloud",
      );
      const fetchMock = mockRegistrationFlow();

      const response = await ctx.app.inject({
        method: "POST",
        url: "/api/oauth/initiate",
        payload: { catalogId: catalog.id },
      });

      expect(response.statusCode, response.body).toBe(200);
      expect(readRegisteredClientName(fetchMock)).toBe(
        "Archestra Platform - Acme Cloud",
      );
    } finally {
      (
        config.enterpriseFeatures as { fullWhiteLabeling: boolean }
      ).fullWhiteLabeling = original;
    }
  });
});

describe("OAuth dynamic client registration scope fallback", () => {
  const ctx = useRouteTestApp(oauthRoutes);
  const originalFetch = globalThis.fetch;
  const REGISTRATION_ENDPOINT = "https://auth.example.com/register";

  beforeEach(() => {
    cacheManager.start();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  // A catalog item without a client_id whose configured scopes have gone stale
  // relative to what the authorization server accepts today.
  const makeStaleScopeCatalog = (
    makeInternalMcpCatalog: (
      overrides?: Record<string, unknown>,
    ) => Promise<{ id: string; name: string }>,
  ) =>
    makeInternalMcpCatalog({
      organizationId: ctx.organizationId,
      name: "Stale Scope MCP",
      serverType: "remote",
      serverUrl: "https://mcp.example.com/mcp",
      oauthConfig: {
        name: "Stale Scope MCP",
        server_url: "https://mcp.example.com/mcp",
        grant_type: "authorization_code",
        client_id: "",
        redirect_uris: ["http://localhost:3000/oauth-callback"],
        scopes: ["read", "write"],
        default_scopes: ["read", "write"],
        supports_resource_metadata: false,
      },
    });

  // A catalog item whose operator deliberately left the scopes field blank, so
  // the request should carry whatever the server advertises — and nothing at
  // all when it advertises nothing.
  const makeBlankScopeCatalog = (
    makeInternalMcpCatalog: (
      overrides?: Record<string, unknown>,
    ) => Promise<{ id: string; name: string }>,
  ) =>
    makeInternalMcpCatalog({
      organizationId: ctx.organizationId,
      name: "Blank Scope MCP",
      serverType: "remote",
      serverUrl: "https://mcp.example.com/mcp",
      oauthConfig: {
        name: "Blank Scope MCP",
        server_url: "https://mcp.example.com/mcp",
        grant_type: "authorization_code",
        client_id: "",
        redirect_uris: ["http://localhost:3000/oauth-callback"],
        scopes: [],
        default_scopes: [],
        supports_resource_metadata: false,
      },
    });

  /**
   * Metadata requests advertise a registration endpoint; the registration
   * POST behavior is delegated to `onRegister` so each test can shape the
   * server's scope policy.
   */
  const mockAuthServer = (
    onRegister: (body: Record<string, unknown>) => {
      ok: boolean;
      status?: number;
      payload: Record<string, unknown>;
    },
    metadataExtra: Record<string, unknown> = {},
  ): Mock => {
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input) === REGISTRATION_ENDPOINT) {
          const body = JSON.parse(String(init?.body));
          const result = onRegister(body);
          return {
            ok: result.ok,
            status: result.status ?? (result.ok ? 201 : 400),
            json: async () => result.payload,
            text: async () => JSON.stringify(result.payload),
          };
        }
        return {
          ok: true,
          json: async () => ({
            authorization_endpoint: "https://auth.example.com/authorize",
            token_endpoint: "https://auth.example.com/token",
            registration_endpoint: REGISTRATION_ENDPOINT,
            ...metadataExtra,
          }),
        };
      },
    ) as Mock;
    globalThis.fetch = fetchMock;
    return fetchMock;
  };

  const initiate = (catalogId: string) =>
    ctx.app.inject({
      method: "POST",
      url: "/api/oauth/initiate",
      payload: { catalogId },
    });

  test("retries registration without scope when the server rejects the scope list and authorizes with the granted scope", async ({
    makeInternalMcpCatalog,
  }) => {
    const catalog = await makeStaleScopeCatalog(makeInternalMcpCatalog);
    const fetchMock = mockAuthServer((body) =>
      "scope" in body
        ? {
            ok: false,
            payload: {
              error: "invalid_client_metadata",
              error_description:
                "None of the requested scopes are available to self-registered clients. Omit `scope` to register with the default scope set.",
            },
          }
        : {
            ok: true,
            payload: { client_id: "dyn-client", scope: "things:read" },
          },
    );

    const response = await initiate(catalog.id);

    expect(response.statusCode, response.body).toBe(200);
    const authorizationUrl = new URL(response.json().authorizationUrl);
    expect(authorizationUrl.searchParams.get("client_id")).toBe("dyn-client");
    // The rejected configured scopes must not reach the authorization
    // endpoint; the server-granted scope set takes their place.
    expect(authorizationUrl.searchParams.get("scope")).toBe("things:read");

    const registrationCalls = fetchMock.mock.calls.filter(
      ([input]) => String(input) === REGISTRATION_ENDPOINT,
    );
    expect(registrationCalls).toHaveLength(2);
    expect(
      JSON.parse(String(registrationCalls[1]?.[1]?.body)),
    ).not.toHaveProperty("scope");
  });

  test("retries with the server's advertised scopes when the configured scopes are rejected", async ({
    makeInternalMcpCatalog,
  }) => {
    const catalog = await makeStaleScopeCatalog(makeInternalMcpCatalog);
    const fetchMock = mockAuthServer(
      (body) => {
        const scope = body.scope as string | undefined;
        if (scope === "things:read things:write") {
          return {
            ok: true,
            payload: { client_id: "dyn-client", scope: "things:read" },
          };
        }
        return {
          ok: false,
          payload: {
            error: "invalid_client_metadata",
            error_description: "Requested scopes are not available.",
          },
        };
      },
      { scopes_supported: ["things:read", "things:write"] },
    );

    const response = await initiate(catalog.id);

    expect(response.statusCode, response.body).toBe(200);
    const authorizationUrl = new URL(response.json().authorizationUrl);
    expect(authorizationUrl.searchParams.get("client_id")).toBe("dyn-client");
    // The advertised-scope registration succeeded and the server narrowed the
    // grant, so the authorization request uses the granted set.
    expect(authorizationUrl.searchParams.get("scope")).toBe("things:read");

    const registrationCalls = fetchMock.mock.calls.filter(
      ([input]) => String(input) === REGISTRATION_ENDPOINT,
    );
    // Configured attempt, then advertised-scope retry — no scope-less attempt.
    expect(registrationCalls).toHaveLength(2);
  });

  test("omits the scope parameter entirely when the scope-less registration reports no granted scope", async ({
    makeInternalMcpCatalog,
  }) => {
    const catalog = await makeStaleScopeCatalog(makeInternalMcpCatalog);
    mockAuthServer((body) =>
      "scope" in body
        ? { ok: false, payload: { error: "invalid_client_metadata" } }
        : { ok: true, payload: { client_id: "dyn-client" } },
    );

    const response = await initiate(catalog.id);

    expect(response.statusCode, response.body).toBe(200);
    const authorizationUrl = new URL(response.json().authorizationUrl);
    expect(authorizationUrl.searchParams.get("client_id")).toBe("dyn-client");
    // No granted scope reported: defer to the server's default scope set for
    // this client instead of re-sending the scopes it just rejected.
    expect(authorizationUrl.searchParams.has("scope")).toBe(false);
  });

  test("prefers the granted scope from a first-attempt registration response", async ({
    makeInternalMcpCatalog,
  }) => {
    const catalog = await makeStaleScopeCatalog(makeInternalMcpCatalog);
    const fetchMock = mockAuthServer(() => ({
      ok: true,
      payload: { client_id: "dyn-client", scope: "read" },
    }));

    const response = await initiate(catalog.id);

    expect(response.statusCode, response.body).toBe(200);
    const authorizationUrl = new URL(response.json().authorizationUrl);
    // RFC 7591: the registration response's `scope` is what the client may
    // use — requesting more would fail at the authorization endpoint.
    expect(authorizationUrl.searchParams.get("scope")).toBe("read");
    expect(
      fetchMock.mock.calls.filter(
        ([input]) => String(input) === REGISTRATION_ENDPOINT,
      ),
    ).toHaveLength(1);
  });

  test("sends no scope when the catalog configures none and the server advertises none", async ({
    makeInternalMcpCatalog,
  }) => {
    const catalog = await makeBlankScopeCatalog(makeInternalMcpCatalog);
    const fetchMock = mockAuthServer(() => ({
      ok: true,
      payload: { client_id: "dyn-client" },
    }));

    const response = await initiate(catalog.id);

    expect(response.statusCode, response.body).toBe(200);
    const authorizationUrl = new URL(response.json().authorizationUrl);
    // A blank scopes field means "let the server apply its own default scope
    // set": neither invented scopes nor a lone `offline_access` may stand in
    // for it, and `scope=` must not be sent empty either.
    expect(authorizationUrl.searchParams.has("scope")).toBe(false);

    const registrationCalls = fetchMock.mock.calls.filter(
      ([input]) => String(input) === REGISTRATION_ENDPOINT,
    );
    // One attempt only: with no scope to drop there is no narrower retry.
    expect(registrationCalls).toHaveLength(1);
    expect(
      JSON.parse(String(registrationCalls[0]?.[1]?.body)),
    ).not.toHaveProperty("scope");
  });

  test("surfaces the registration failure when both attempts fail", async ({
    makeInternalMcpCatalog,
  }) => {
    const catalog = await makeStaleScopeCatalog(makeInternalMcpCatalog);
    mockAuthServer(() => ({
      ok: false,
      payload: {
        error: "invalid_client_metadata",
        error_description: "Registration is disabled for this tenant.",
      },
    }));

    const response = await initiate(catalog.id);

    expect(response.statusCode, response.body).toBe(400);
    const message = response.json().error.message as string;
    expect(message).toContain("dynamic client registration failed");
    expect(message).toContain("Registration is disabled for this tenant.");
  });
});
