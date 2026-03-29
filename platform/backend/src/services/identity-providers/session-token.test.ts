import { randomUUID } from "node:crypto";
import db, { schema } from "@/database";
import { describe, expect, test } from "@/test";
import { resolveSessionExternalIdpToken } from "./session-token";

describe("resolveSessionExternalIdpToken", () => {
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
