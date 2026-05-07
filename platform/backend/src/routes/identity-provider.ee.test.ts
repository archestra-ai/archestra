import { vi } from "vitest";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";
import { getIdpLogoutUrl } from "./identity-provider.ee";

describe("getIdpLogoutUrl", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("returns null for non-SSO user (credential-only account)", async ({
    makeUser,
  }) => {
    const user = await makeUser();
    // The makeUser fixture creates a "credential" provider account by default

    const url = await getIdpLogoutUrl(user.id);
    expect(url).toBeNull();
  });

  test("returns null for SAML provider (no oidcConfig)", async ({
    makeUser,
    makeAccount,
    makeOrganization,
    makeIdentityProvider,
  }) => {
    const user = await makeUser();
    const org = await makeOrganization();

    // Create an SSO provider with SAML config (no OIDC)
    await makeIdentityProvider(org.id, {
      providerId: "saml-provider",
      samlConfig: {
        entityId: "https://saml.example.com",
        signOnUrl: "https://saml.example.com/sso",
        certificate: "test-cert",
      },
    });

    // Create an SSO account linked to the SAML provider
    await makeAccount(user.id, {
      providerId: "saml-provider",
    });

    const url = await getIdpLogoutUrl(user.id);
    expect(url).toBeNull();
  });

  test("returns constructed URL for OIDC provider with valid discovery doc", async ({
    makeUser,
    makeAccount,
    makeOrganization,
    makeIdentityProvider,
  }) => {
    const user = await makeUser();
    const org = await makeOrganization();

    await makeIdentityProvider(org.id, {
      providerId: "oidc-provider",
      oidcConfig: {
        clientId: "test-client",
        clientSecret: "test-secret",
        issuer: "https://idp.example.com",
        pkce: false,
        enableRpInitiatedLogout: true,
        discoveryEndpoint:
          "https://idp.example.com/.well-known/openid-configuration",
      },
    });

    const testIdToken = "eyJhbGciOiJSUzI1NiJ9.test-id-token";
    await makeAccount(user.id, {
      providerId: "oidc-provider",
      idToken: testIdToken,
    });

    // Mock fetch to return a discovery doc with end_session_endpoint
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        issuer: "https://idp.example.com",
        end_session_endpoint:
          "https://idp.example.com/protocol/openid-connect/logout",
      }),
    });

    const url = await getIdpLogoutUrl(user.id);

    expect(url).not.toBeNull();
    const parsed = new URL(url as string);
    expect(parsed.origin + parsed.pathname).toBe(
      "https://idp.example.com/protocol/openid-connect/logout",
    );
    expect(parsed.searchParams.get("id_token_hint")).toBe(testIdToken);
    expect(parsed.searchParams.get("client_id")).toBe("test-client");
    expect(parsed.searchParams.get("post_logout_redirect_uri")).toContain(
      "/auth/sign-in",
    );
  });

  test("omits post_logout_redirect_uri when provider disables RP-Initiated Logout", async ({
    makeUser,
    makeAccount,
    makeOrganization,
    makeIdentityProvider,
  }) => {
    const user = await makeUser();
    const org = await makeOrganization();

    await makeIdentityProvider(org.id, {
      providerId: "oidc-provider-no-redirect",
      oidcConfig: {
        clientId: "test-client",
        clientSecret: "test-secret",
        issuer: "https://idp.example.com",
        pkce: false,
        enableRpInitiatedLogout: false,
        discoveryEndpoint:
          "https://idp.example.com/.well-known/openid-configuration",
      },
    });

    const testIdToken = "eyJhbGciOiJSUzI1NiJ9.test-id-token";
    await makeAccount(user.id, {
      providerId: "oidc-provider-no-redirect",
      idToken: testIdToken,
    });

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        issuer: "https://idp.example.com",
        end_session_endpoint:
          "https://idp.example.com/protocol/openid-connect/logout",
      }),
    });

    const url = await getIdpLogoutUrl(user.id);

    expect(url).not.toBeNull();
    const parsed = new URL(url as string);
    expect(parsed.searchParams.get("id_token_hint")).toBe(testIdToken);
    expect(parsed.searchParams.get("client_id")).toBe("test-client");
    expect(parsed.searchParams.has("post_logout_redirect_uri")).toBe(false);
  });

  test("includes post_logout_redirect_uri by default when the provider does not set the toggle", async ({
    makeUser,
    makeAccount,
    makeOrganization,
    makeIdentityProvider,
  }) => {
    const user = await makeUser();
    const org = await makeOrganization();

    await makeIdentityProvider(org.id, {
      providerId: "oidc-provider-default-no-redirect",
      oidcConfig: {
        clientId: "test-client",
        clientSecret: "test-secret",
        issuer: "https://idp.example.com",
        pkce: false,
        discoveryEndpoint:
          "https://idp.example.com/.well-known/openid-configuration",
      },
    });

    await makeAccount(user.id, {
      providerId: "oidc-provider-default-no-redirect",
      idToken: "eyJhbGciOiJSUzI1NiJ9.test-id-token",
    });

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        issuer: "https://idp.example.com",
        end_session_endpoint:
          "https://idp.example.com/protocol/openid-connect/logout",
      }),
    });

    const url = await getIdpLogoutUrl(user.id);

    expect(url).not.toBeNull();
    const parsed = new URL(url as string);
    expect(parsed.searchParams.get("post_logout_redirect_uri")).toContain(
      "/auth/sign-in",
    );
  });

  test("returns null when discovery fetch fails (graceful degradation)", async ({
    makeUser,
    makeAccount,
    makeOrganization,
    makeIdentityProvider,
  }) => {
    const user = await makeUser();
    const org = await makeOrganization();

    await makeIdentityProvider(org.id, {
      providerId: "oidc-failing",
      oidcConfig: {
        clientId: "test-client",
        clientSecret: "test-secret",
        issuer: "https://idp.example.com",
        pkce: false,
        discoveryEndpoint:
          "https://idp.example.com/.well-known/openid-configuration",
      },
    });

    await makeAccount(user.id, {
      providerId: "oidc-failing",
    });

    // Mock fetch to throw a network error
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("Network error"));

    const url = await getIdpLogoutUrl(user.id);
    expect(url).toBeNull();
  });

  test("returns null when discovery fetch returns non-2xx status", async ({
    makeUser,
    makeAccount,
    makeOrganization,
    makeIdentityProvider,
  }) => {
    const user = await makeUser();
    const org = await makeOrganization();

    await makeIdentityProvider(org.id, {
      providerId: "oidc-500",
      oidcConfig: {
        clientId: "test-client",
        clientSecret: "test-secret",
        issuer: "https://idp.example.com",
        pkce: false,
        discoveryEndpoint:
          "https://idp.example.com/.well-known/openid-configuration",
      },
    });

    await makeAccount(user.id, {
      providerId: "oidc-500",
    });

    // Mock fetch to return a 500 server error
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
    });

    const url = await getIdpLogoutUrl(user.id);
    expect(url).toBeNull();
  });

  test("returns null when discovery doc has no end_session_endpoint", async ({
    makeUser,
    makeAccount,
    makeOrganization,
    makeIdentityProvider,
  }) => {
    const user = await makeUser();
    const org = await makeOrganization();

    await makeIdentityProvider(org.id, {
      providerId: "oidc-no-logout",
      oidcConfig: {
        clientId: "test-client",
        clientSecret: "test-secret",
        issuer: "https://idp.example.com",
        pkce: false,
        discoveryEndpoint:
          "https://idp.example.com/.well-known/openid-configuration",
      },
    });

    await makeAccount(user.id, {
      providerId: "oidc-no-logout",
    });

    // Mock fetch to return a discovery doc WITHOUT end_session_endpoint
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        issuer: "https://idp.example.com",
        authorization_endpoint: "https://idp.example.com/authorize",
        token_endpoint: "https://idp.example.com/token",
        // no end_session_endpoint
      }),
    });

    const url = await getIdpLogoutUrl(user.id);
    expect(url).toBeNull();
  });
});

describe("identity provider routes", () => {
  let app: FastifyInstanceWithZod;
  let user: User;
  let organizationId: string;

  beforeEach(async ({ makeOrganization, makeUser }) => {
    user = await makeUser();
    const organization = await makeOrganization();
    organizationId = organization.id;

    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      (request as typeof request & { user: unknown }).user = user;
      (
        request as typeof request & {
          organizationId: string;
        }
      ).organizationId = organizationId;
    });

    const { default: identityProviderRoutes } = await import(
      "./identity-provider.ee"
    );
    await app.register(identityProviderRoutes);
  });

  afterEach(async () => {
    await app.close();
  });

  describe("GET /api/identity-providers", () => {
    test("returns empty array when no providers exist", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/api/identity-providers",
      });

      expect(response.statusCode).toBe(200);
      const data = response.json();
      expect(Array.isArray(data)).toBe(true);
      expect(data).toHaveLength(0);
    });

    test("returns array of providers", async ({ makeIdentityProvider }) => {
      await makeIdentityProvider(organizationId, {
        providerId: "route-test-provider",
        oidcConfig: {
          clientId: "test-client",
          clientSecret: "test-secret",
          issuer: "https://idp.example.com",
          pkce: false,
          discoveryEndpoint:
            "https://idp.example.com/.well-known/openid-configuration",
        },
      });

      const response = await app.inject({
        method: "GET",
        url: "/api/identity-providers",
      });

      expect(response.statusCode).toBe(200);
      const data = response.json();
      expect(Array.isArray(data)).toBe(true);
      expect(data.length).toBeGreaterThanOrEqual(1);
      expect(data[0]).toHaveProperty("providerId", "route-test-provider");
    });
  });

  describe("GET /api/identity-providers/public", () => {
    test("returns only id and providerId fields", async ({
      makeIdentityProvider,
    }) => {
      await makeIdentityProvider(organizationId, {
        providerId: "public-test-provider",
        oidcConfig: {
          clientId: "test-client",
          clientSecret: "test-secret",
          issuer: "https://idp.example.com",
          pkce: false,
          discoveryEndpoint:
            "https://idp.example.com/.well-known/openid-configuration",
        },
      });

      const response = await app.inject({
        method: "GET",
        url: "/api/identity-providers/public",
      });

      expect(response.statusCode).toBe(200);
      const data = response.json();
      expect(Array.isArray(data)).toBe(true);
      expect(data.length).toBeGreaterThanOrEqual(1);

      const provider = data.find(
        (p: { providerId: string }) => p.providerId === "public-test-provider",
      );
      expect(provider).toBeDefined();
      expect(provider).toHaveProperty("id");
      expect(provider).toHaveProperty("providerId");
      expect(provider).not.toHaveProperty("oidcConfig");
      expect(provider).not.toHaveProperty("samlConfig");
    });

    test("hides providers disabled for SSO login", async ({
      makeIdentityProvider,
    }) => {
      await makeIdentityProvider(organizationId, {
        providerId: "primary-login-provider",
        ssoLoginEnabled: true,
      });
      await makeIdentityProvider(organizationId, {
        providerId: "brokered-token-provider",
        ssoLoginEnabled: false,
      });

      const response = await app.inject({
        method: "GET",
        url: "/api/identity-providers/public",
      });

      expect(response.statusCode).toBe(200);
      const data = response.json() as Array<{ providerId: string }>;
      expect(data.map((provider) => provider.providerId)).toContain(
        "primary-login-provider",
      );
      expect(data.map((provider) => provider.providerId)).not.toContain(
        "brokered-token-provider",
      );
    });

    test("returns empty array when no providers exist", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/api/identity-providers/public",
      });

      expect(response.statusCode).toBe(200);
      const data = response.json();
      expect(Array.isArray(data)).toBe(true);
      expect(data).toHaveLength(0);
    });
  });

  describe("GET /api/identity-providers/:id", () => {
    test("returns 404 for non-existent provider", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/api/identity-providers/non-existent-id",
      });

      expect(response.statusCode).toBe(404);
    });

    test("returns provider by id", async ({ makeIdentityProvider }) => {
      const idp = await makeIdentityProvider(organizationId, {
        providerId: "get-by-id-provider",
        oidcConfig: {
          clientId: "test-client",
          clientSecret: "test-secret",
          issuer: "https://idp.example.com",
          pkce: false,
          discoveryEndpoint:
            "https://idp.example.com/.well-known/openid-configuration",
        },
      });

      const response = await app.inject({
        method: "GET",
        url: `/api/identity-providers/${idp.id}`,
      });

      expect(response.statusCode).toBe(200);
      const data = response.json();
      expect(data).toHaveProperty("id", idp.id);
      expect(data).toHaveProperty("providerId", "get-by-id-provider");
    });
  });

  describe("GET /api/identity-providers/idp-logout-url", () => {
    test("returns null url for non-SSO user", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/api/identity-providers/idp-logout-url",
      });

      expect(response.statusCode).toBe(200);
      const data = response.json();
      expect(data).toEqual({ url: null });
    });
  });
});
