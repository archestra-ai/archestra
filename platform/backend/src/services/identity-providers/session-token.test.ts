import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import db, { schema } from "@/database";
import { afterEach, describe, expect, test, vi } from "@/test";
import { resolveSessionExternalIdpToken } from "./session-token";

describe("resolveSessionExternalIdpToken", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  test("returns the matching session IdP token for the gateway", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeIdentityProvider,
    makeAgent,
    makeAccount,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    await makeMember(user.id, org.id, { role: "member" });

    const identityProvider = await makeIdentityProvider(org.id, {
      providerId: "okta-chat",
      oidcConfig: { clientId: "okta-client-id" },
    });
    const agent = await makeAgent({
      organizationId: org.id,
      identityProviderId: identityProvider.id,
    });

    await makeAccount(user.id, {
      providerId: "okta-chat",
      idToken: createJwt({ exp: futureExpSeconds() }),
    });
    await makeAccount(user.id, {
      providerId: "other-provider",
      idToken: createJwt({ exp: futureExpSeconds() }),
    });

    const result = await resolveSessionExternalIdpToken({
      agentId: agent.id,
      userId: user.id,
    });

    expect(result).toEqual({
      identityProviderId: identityProvider.id,
      providerId: "okta-chat",
      rawToken: expect.any(String),
    });
  });

  test("returns null when the matching IdP token is expired", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeIdentityProvider,
    makeAgent,
    makeAccount,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    await makeMember(user.id, org.id, { role: "member" });

    const identityProvider = await makeIdentityProvider(org.id, {
      providerId: "okta-expired",
      oidcConfig: { clientId: "okta-client-id" },
    });
    const agent = await makeAgent({
      organizationId: org.id,
      identityProviderId: identityProvider.id,
    });

    await makeAccount(user.id, {
      providerId: "okta-expired",
      idToken: createJwt({ exp: Math.floor(Date.now() / 1000) - 60 }),
    });

    const result = await resolveSessionExternalIdpToken({
      agentId: agent.id,
      userId: user.id,
    });

    expect(result).toBeNull();
  });

  test("returns null when the matching ID token has no exp claim", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeIdentityProvider,
    makeAgent,
    makeAccount,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    await makeMember(user.id, org.id, { role: "member" });

    const identityProvider = await makeIdentityProvider(org.id, {
      providerId: "okta-no-exp",
      oidcConfig: { clientId: "okta-client-id" },
    });
    const agent = await makeAgent({
      organizationId: org.id,
      identityProviderId: identityProvider.id,
    });

    await makeAccount(user.id, {
      providerId: "okta-no-exp",
      idToken: createJwt({ sub: "user-123" }),
    });

    const result = await resolveSessionExternalIdpToken({
      agentId: agent.id,
      userId: user.id,
    });

    expect(result).toBeNull();
  });

  test("uses the stored access token when the identity provider is configured for access_token subject exchange", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeIdentityProvider,
    makeAgent,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    await makeMember(user.id, org.id, { role: "member" });

    const identityProvider = await makeIdentityProvider(org.id, {
      providerId: "keycloak-enterprise",
      issuer: "http://localhost:30081/realms/archestra",
      oidcConfig: {
        clientId: "archestra-oidc",
        enterpriseManagedCredentials: {
          providerType: "keycloak",
          subjectTokenType: "urn:ietf:params:oauth:token-type:access_token",
        },
      },
    });
    const agent = await makeAgent({
      organizationId: org.id,
      identityProviderId: identityProvider.id,
    });

    await db.insert(schema.accountsTable).values({
      id: randomUUID(),
      accountId: "acct-keycloak-enterprise",
      providerId: "keycloak-enterprise",
      userId: user.id,
      accessToken: "keycloak-access-token",
      accessTokenExpiresAt: new Date(Date.now() + 3600_000),
      idToken: createJwt({ exp: futureExpSeconds() }),
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const result = await resolveSessionExternalIdpToken({
      agentId: agent.id,
      userId: user.id,
    });

    expect(result).toEqual({
      identityProviderId: identityProvider.id,
      providerId: "keycloak-enterprise",
      rawToken: "keycloak-access-token",
    });
  });

  test("refreshes an expired stored access token when refresh is possible", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeIdentityProvider,
    makeAgent,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    await makeMember(user.id, org.id, { role: "member" });

    const identityProvider = await makeIdentityProvider(org.id, {
      providerId: "keycloak-refreshable",
      issuer: "http://localhost:30081/realms/archestra",
      oidcConfig: {
        clientId: "archestra-oidc",
        clientSecret: "archestra-oidc-secret",
        tokenEndpoint:
          "http://localhost:30081/realms/archestra/protocol/openid-connect/token",
        tokenEndpointAuthentication: "client_secret_post",
        enterpriseManagedCredentials: {
          providerType: "keycloak",
          subjectTokenType: "urn:ietf:params:oauth:token-type:access_token",
        },
      },
    });
    const agent = await makeAgent({
      organizationId: org.id,
      identityProviderId: identityProvider.id,
    });

    await db.insert(schema.accountsTable).values({
      id: randomUUID(),
      accountId: "acct-keycloak-refreshable",
      providerId: "keycloak-refreshable",
      userId: user.id,
      accessToken: "expired-access-token",
      accessTokenExpiresAt: new Date(Date.now() - 60_000),
      refreshToken: "refresh-token-123",
      refreshTokenExpiresAt: new Date(Date.now() + 3_600_000),
      idToken: createJwt({ exp: futureExpSeconds() }),
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        access_token: "refreshed-access-token",
        refresh_token: "refresh-token-456",
        expires_in: 3600,
      }),
    }) as typeof fetch;

    const result = await resolveSessionExternalIdpToken({
      agentId: agent.id,
      userId: user.id,
    });

    expect(result).toEqual({
      identityProviderId: identityProvider.id,
      providerId: "keycloak-refreshable",
      rawToken: "refreshed-access-token",
    });

    const [persistedAccount] = await db
      .select()
      .from(schema.accountsTable)
      .where(eq(schema.accountsTable.providerId, "keycloak-refreshable"))
      .limit(1);
    expect(persistedAccount?.accessToken).toBe("refreshed-access-token");
    expect(persistedAccount?.refreshToken).toBe("refresh-token-456");
  });

  test("treats access tokens without an expiry as unusable for access-token subject exchange", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeIdentityProvider,
    makeAgent,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    await makeMember(user.id, org.id, { role: "member" });

    const identityProvider = await makeIdentityProvider(org.id, {
      providerId: "keycloak-no-expiry",
      issuer: "http://localhost:30081/realms/archestra",
      oidcConfig: {
        clientId: "archestra-oidc",
        enterpriseManagedCredentials: {
          providerType: "keycloak",
          subjectTokenType: "urn:ietf:params:oauth:token-type:access_token",
        },
      },
    });
    const agent = await makeAgent({
      organizationId: org.id,
      identityProviderId: identityProvider.id,
    });

    await db.insert(schema.accountsTable).values({
      id: randomUUID(),
      accountId: "acct-keycloak-no-expiry",
      providerId: "keycloak-no-expiry",
      userId: user.id,
      accessToken: "access-token-without-expiry",
      accessTokenExpiresAt: null,
      idToken: createJwt({ exp: futureExpSeconds() }),
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const result = await resolveSessionExternalIdpToken({
      agentId: agent.id,
      userId: user.id,
    });

    expect(result).toBeNull();
  });
});

function createJwt(payload: Record<string, unknown>): string {
  return [
    base64UrlEncode({ alg: "none", typ: "JWT" }),
    base64UrlEncode(payload),
    "",
  ].join(".");
}

function base64UrlEncode(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function futureExpSeconds(): number {
  return Math.floor(Date.now() / 1000) + 3600;
}
