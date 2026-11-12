import { eq } from "drizzle-orm";
import db, { schema } from "@/database";
import ManagedOauthClientModel from "@/models/managed-oauth-client";
import MemberModel from "@/models/member";
import OAuthAccessTokenModel from "@/models/oauth-access-token";
import OAuthClientModel from "@/models/oauth-client";
import VirtualApiKeyModel from "@/models/virtual-api-key";
import { expect, test } from "@/test";
import { resolveMarketplaceViewer } from "./static-marketplace";

const resolve = (token: string) =>
  resolveMarketplaceViewer({ authorization: `Bearer ${token}` });

test("browser OAuth uses current client, token and membership state", async ({
  makeOrganization,
  makeUser,
  makeMember,
  makeOAuthClient,
  makeOAuthAccessToken,
  makeOAuthRefreshToken,
}) => {
  const org = await makeOrganization({ skillMarketplaceAnonymousAccess: true });
  const user = await makeUser();
  await makeMember(user.id, org.id);
  const client = await makeOAuthClient({ scopes: ["mcp", "offline_access"] });
  const value = crypto.randomUUID();
  const tokenHash = OAuthAccessTokenModel.hashTokenForLookup(value);
  const refresh = await makeOAuthRefreshToken(client.clientId, user.id);
  const token = await makeOAuthAccessToken(client.clientId, user.id, {
    token: tokenHash,
    refreshId: refresh.id,
  });
  const denied = { status: "unauthenticated" };
  const allowed = {
    status: "ok",
    viewer: { userId: user.id, organizationId: org.id },
  };
  expect(await resolve(value)).toMatchObject(allowed);
  for (const authorization of [
    `Basic ${Buffer.from(`user:${value}`).toString("base64")}`,
    `Basic ${Buffer.from(`${value}:`).toString("base64")}`,
  ])
    expect(await resolveMarketplaceViewer({ authorization })).toMatchObject(
      allowed,
    );

  // Token scope cannot be supplied by the client's wider capabilities.
  await db
    .update(schema.oauthAccessTokensTable)
    .set({ scopes: ["llm:proxy"] })
    .where(eq(schema.oauthAccessTokensTable.id, token.id));
  expect(await resolve(value)).toEqual(denied);
  await db
    .update(schema.oauthAccessTokensTable)
    .set({ scopes: ["mcp"] })
    .where(eq(schema.oauthAccessTokensTable.id, token.id));
  for (const referenceId of [
    "mcp-resource:gateway",
    "mcp-app-resource:connector",
    "mcp-oauth-client:service",
    "oauth-client:service",
    "unknown-binding",
  ]) {
    await db
      .update(schema.oauthAccessTokensTable)
      .set({ referenceId })
      .where(eq(schema.oauthAccessTokensTable.id, token.id));
    expect(await resolve(value)).toEqual(denied);
  }
  await db
    .update(schema.oauthAccessTokensTable)
    .set({ referenceId: null })
    .where(eq(schema.oauthAccessTokensTable.id, token.id));
  await OAuthAccessTokenModel.updateExpiresAtByTokenHash({
    tokenHash,
    expiresAt: new Date(0),
  });
  expect(await resolve(value)).toEqual(denied);
  await OAuthAccessTokenModel.updateExpiresAtByTokenHash({
    tokenHash,
    expiresAt: new Date(Date.now() + 60_000),
  });
  await db
    .update(schema.oauthRefreshTokensTable)
    .set({ revoked: new Date() })
    .where(eq(schema.oauthRefreshTokensTable.id, refresh.id));
  expect(await resolve(value)).toEqual(denied);
  await db
    .update(schema.oauthRefreshTokensTable)
    .set({ revoked: null })
    .where(eq(schema.oauthRefreshTokensTable.id, refresh.id));
  for (const fields of [
    { disabled: true },
    { scopes: ["llm:proxy"] },
    { grantTypes: ["client_credentials"] },
  ]) {
    await db
      .update(schema.oauthClientsTable)
      .set(fields)
      .where(eq(schema.oauthClientsTable.id, client.id));
    expect(await resolve(value)).toEqual(denied);
    await db
      .update(schema.oauthClientsTable)
      .set({
        disabled: false,
        scopes: ["mcp"],
        grantTypes: ["authorization_code", "refresh_token"],
      })
      .where(eq(schema.oauthClientsTable.id, client.id));
  }
  expect(await resolve(value)).toMatchObject(allowed);
  await MemberModel.deleteAllByUserId(user.id);
  expect(await resolve(value)).toEqual(denied);
});

test("internal issuers, client credentials and virtual keys cannot become marketplace users", async ({
  makeOrganization,
  makeUser,
  makeMember,
  makeOAuthClient,
  makeOAuthAccessToken,
}) => {
  const org = await makeOrganization({ skillMarketplaceAnonymousAccess: true });
  const user = await makeUser();
  await makeMember(user.id, org.id);
  for (const clientId of [
    "archestra-agent-runtime",
    "archestra-github-actions",
    "archestra-enterprise-managed",
  ]) {
    await OAuthClientModel.ensurePlatformIssuedClient({
      id: clientId,
      clientId,
      name: "Internal issuer",
    });
    const value = crypto.randomUUID();
    await makeOAuthAccessToken(clientId, user.id, {
      token: OAuthAccessTokenModel.hashTokenForLookup(value),
    });
    expect(await resolve(value)).toEqual({ status: "unauthenticated" });
  }
  const client = await makeOAuthClient({ scopes: ["mcp"] });
  const value = crypto.randomUUID();
  await OAuthAccessTokenModel.createClientCredentialsToken({
    clientId: client.clientId,
    tokenHash: OAuthAccessTokenModel.hashTokenForLookup(value),
    expiresAt: new Date(Date.now() + 60_000),
    scopes: ["mcp"],
  });
  expect(await resolve(value)).toEqual({ status: "unauthenticated" });
  const key = await VirtualApiKeyModel.create({
    organizationId: org.id,
    authorId: user.id,
    name: "Personal LLM key",
  });
  expect(await resolve(key.value)).toEqual({ status: "unauthenticated" });
});

test("OAuth cannot bypass marketplace permissions or a managed client's organization", async ({
  makeOrganization,
  makeUser,
  makeMember,
  makeCustomRole,
  makeOAuthAccessToken,
}) => {
  const org = await makeOrganization();
  const user = await makeUser();
  const role = await makeCustomRole(org.id, {
    permission: { agent: ["read"] },
  });
  await makeMember(user.id, org.id, { role: role.role });
  const { oauthClient: client } = await ManagedOauthClientModel.create({
    organizationId: org.id,
    authorId: user.id,
    name: "Browser integration",
    grantType: "authorization_code",
    scopes: ["mcp"],
  });
  const value = crypto.randomUUID();
  await makeOAuthAccessToken(client.clientId, user.id, {
    token: OAuthAccessTokenModel.hashTokenForLookup(value),
  });
  expect(await resolve(value)).toEqual({ status: "forbidden" });
  const other = await makeOrganization();
  await db
    .update(schema.oauthClientsTable)
    .set({
      metadata: {
        ...((await OAuthClientModel.findByClientId(client.clientId))
          ?.metadata as object),
        organizationId: other.id,
      },
    })
    .where(eq(schema.oauthClientsTable.clientId, client.clientId));
  expect(await resolve(value)).toEqual({ status: "unauthenticated" });
});
