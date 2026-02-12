import { afterEach, vi } from "vitest";
import { describe, expect, test } from "@/test";
import { getIdpLogoutUrl } from "./identity-provider.ee";

// Mock the logger to avoid console output during tests
vi.mock("@/logging", () => ({
  default: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

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
