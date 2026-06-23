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
        scopesToUse: ["READ"],
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
        scopesToUse: ["jira:read"],
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
        scopesToUse: ["jira:write"],
      });

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
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock).toHaveBeenCalledWith(
        "https://auth.example.com/.well-known/openid-configuration",
        expect.anything(),
      );

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
          json: async () => ({
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
      json: async () => ({
        access_token: "new-access-token",
        refresh_token: "new-refresh-token",
        expires_in: 3600,
      }),
    }) as Mock;
    globalThis.fetch = fetchMock;

    await expect(refreshOAuthToken(secret.id, catalog.id)).resolves.toBe(true);

    const requestBody = fetchMock.mock.calls.at(-1)?.[1]
      ?.body as URLSearchParams;
    expect(requestBody.get("grant_type")).toBe("refresh_token");
    expect(requestBody.get("refresh_token")).toBe("stored-refresh-token");
    expect(requestBody.get("resource")).toBe("https://mcp.example.com");
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
          json: async () => ({
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

    await expect(refreshOAuthToken(secret.id, catalog.id)).resolves.toBe(true);

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
