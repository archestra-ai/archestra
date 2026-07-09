import { afterEach, describe, expect, vi } from "vitest";
import {
  McpOauthClientModel,
  OAuthAccessTokenModel,
  OAuthClientModel,
  OAuthRefreshTokenModel,
} from "@/models";
import {
  REFRESH_TOKEN_REUSE_GRACE_MS,
  shieldRefreshTokenGrant,
  shieldRevocationRequest,
} from "@/services/oauth-refresh-replay";
import { test } from "@/test";

const CIMD_CLIENT_ID = "https://claude.example.com/.well-known/claude-code";
const OTHER_CLIENT_ID = "https://other.example.com/.well-known/other-client";

afterEach(() => {
  vi.useRealTimers();
});

async function makePublicClient(clientId: string) {
  await OAuthClientModel.upsertFromCimd({
    id: crypto.randomUUID(),
    clientId,
    name: "Test MCP client",
    redirectUris: ["http://localhost:1455/callback"],
    grantTypes: ["authorization_code", "refresh_token"],
    responseTypes: ["code"],
    scopes: ["mcp", "offline_access"],
    tokenEndpointAuthMethod: "none",
    isPublic: true,
    metadata: { cimd: true },
  });
}

/** Seed one grant (a refresh token and an access token minted from it). */
async function seedGrant(params: {
  clientId: string;
  userId: string;
  referenceId?: string | null;
  revoked?: boolean;
}) {
  const refreshToken = `refresh-${crypto.randomUUID()}`;
  const accessToken = `access-${crypto.randomUUID()}`;
  const refreshRow = await OAuthRefreshTokenModel.create({
    tokenHash: OAuthRefreshTokenModel.hashTokenForLookup(refreshToken),
    clientId: params.clientId,
    userId: params.userId,
    referenceId: params.referenceId ?? null,
    scopes: ["mcp", "offline_access"],
    expiresAt: new Date(Date.now() + 30 * 24 * 3600 * 1000),
  });
  await OAuthAccessTokenModel.create({
    tokenHash: OAuthAccessTokenModel.hashTokenForLookup(accessToken),
    clientId: params.clientId,
    userId: params.userId,
    referenceId: params.referenceId ?? null,
    refreshId: refreshRow.id,
    scopes: ["mcp", "offline_access"],
    expiresAt: new Date(Date.now() + 3600 * 1000),
  });
  if (params.revoked) {
    await OAuthRefreshTokenModel.revokeByIdWhenActive(refreshRow.id);
  }
  return { refreshToken, accessToken, refreshRowId: refreshRow.id };
}

async function grantStillExists(refreshToken: string): Promise<boolean> {
  const row = await OAuthRefreshTokenModel.getByTokenHash(
    OAuthRefreshTokenModel.hashTokenForLookup(refreshToken),
  );
  return row !== null;
}

function advancePastGraceWindow() {
  vi.useFakeTimers();
  vi.setSystemTime(Date.now() + REFRESH_TOKEN_REUSE_GRACE_MS + 1000);
}

describe("shieldRefreshTokenGrant", () => {
  test("forwards an active refresh token to better-auth", async ({
    makeUser,
  }) => {
    const user = await makeUser();
    await makePublicClient(CIMD_CLIENT_ID);
    const grant = await seedGrant({
      clientId: CIMD_CLIENT_ID,
      userId: user.id,
    });

    const outcome = await shieldRefreshTokenGrant({
      refreshToken: grant.refreshToken,
      clientId: CIMD_CLIENT_ID,
      clientSecret: undefined,
    });

    expect(outcome).toEqual({ action: "forward" });
  });

  test("forwards an unknown refresh token", async () => {
    const outcome = await shieldRefreshTokenGrant({
      refreshToken: "never-issued",
      clientId: CIMD_CLIENT_ID,
      clientSecret: undefined,
    });

    expect(outcome).toEqual({ action: "forward" });
  });

  test("forwards a replayed token presented by a different client (nuke-free invalid_client in better-auth)", async ({
    makeUser,
  }) => {
    const user = await makeUser();
    await makePublicClient(CIMD_CLIENT_ID);
    await makePublicClient(OTHER_CLIENT_ID);
    const grant = await seedGrant({
      clientId: CIMD_CLIENT_ID,
      userId: user.id,
      revoked: true,
    });

    const outcome = await shieldRefreshTokenGrant({
      refreshToken: grant.refreshToken,
      clientId: OTHER_CLIENT_ID,
      clientSecret: undefined,
    });

    expect(outcome).toEqual({ action: "forward" });
  });

  test("re-issues a working pair for a replay within the grace window without touching other grants", async ({
    makeUser,
  }) => {
    const user = await makeUser();
    await makePublicClient(CIMD_CLIENT_ID);
    const replayed = await seedGrant({
      clientId: CIMD_CLIENT_ID,
      userId: user.id,
      referenceId: "mcp-resource:profile-1",
      revoked: true,
    });
    const otherEntry = await seedGrant({
      clientId: CIMD_CLIENT_ID,
      userId: user.id,
      referenceId: "mcp-resource:profile-2",
    });

    const outcome = await shieldRefreshTokenGrant({
      refreshToken: replayed.refreshToken,
      clientId: CIMD_CLIENT_ID,
      clientSecret: undefined,
    });

    expect(outcome.action).toBe("respond");
    if (outcome.action !== "respond") throw new Error("unreachable");
    expect(outcome.statusCode).toBe(200);
    expect(outcome.body).toMatchObject({
      token_type: "Bearer",
      scope: "mcp offline_access",
    });

    // The re-issued pair is a real grant: rows exist, carry the replayed
    // grant's identity, and the refresh token is active.
    const newRefresh = await OAuthRefreshTokenModel.getByTokenHash(
      OAuthRefreshTokenModel.hashTokenForLookup(
        outcome.body.refresh_token as string,
      ),
    );
    expect(newRefresh).not.toBeNull();
    expect(newRefresh?.revoked).toBeNull();
    expect(newRefresh?.referenceId).toBe("mcp-resource:profile-1");
    expect(newRefresh?.userId).toBe(user.id);
    const newAccess = await OAuthAccessTokenModel.getByTokenHash(
      OAuthAccessTokenModel.hashTokenForLookup(
        outcome.body.access_token as string,
      ),
    );
    expect(newAccess?.refreshId).toBe(newRefresh?.id);
    expect(newAccess?.referenceId).toBe("mcp-resource:profile-1");

    // Nothing was invalidated: the other entry's grant and even the replayed
    // (revoked) row are still there.
    expect(await grantStillExists(otherEntry.refreshToken)).toBe(true);
    expect(await grantStillExists(replayed.refreshToken)).toBe(true);
  });

  test("invalidates only the replayed grant's lineage beyond the grace window", async ({
    makeUser,
  }) => {
    const user = await makeUser();
    await makePublicClient(CIMD_CLIENT_ID);
    const replayed = await seedGrant({
      clientId: CIMD_CLIENT_ID,
      userId: user.id,
      referenceId: "mcp-resource:profile-1",
      revoked: true,
    });
    // The rotation winner of the same grant (same resource binding)…
    const successor = await seedGrant({
      clientId: CIMD_CLIENT_ID,
      userId: user.id,
      referenceId: "mcp-resource:profile-1",
    });
    // …and an unrelated MCP entry of the same user + client.
    const otherEntry = await seedGrant({
      clientId: CIMD_CLIENT_ID,
      userId: user.id,
      referenceId: "mcp-resource:profile-2",
    });

    advancePastGraceWindow();
    const outcome = await shieldRefreshTokenGrant({
      refreshToken: replayed.refreshToken,
      clientId: CIMD_CLIENT_ID,
      clientSecret: undefined,
    });

    expect(outcome.action).toBe("respond");
    if (outcome.action !== "respond") throw new Error("unreachable");
    expect(outcome.statusCode).toBe(400);
    expect(outcome.body.error).toBe("invalid_grant");

    // The replayed lineage (including its rotation successor) is gone…
    expect(await grantStillExists(replayed.refreshToken)).toBe(false);
    expect(await grantStillExists(successor.refreshToken)).toBe(false);
    const successorAccess = await OAuthAccessTokenModel.getByTokenHash(
      OAuthAccessTokenModel.hashTokenForLookup(successor.accessToken),
    );
    expect(successorAccess).toBeUndefined();

    // …but the user's other MCP entry survives — the incident behavior
    // (whole client+user family wiped) must not come back.
    expect(await grantStillExists(otherEntry.refreshToken)).toBe(true);
    const otherAccess = await OAuthAccessTokenModel.getByTokenHash(
      OAuthAccessTokenModel.hashTokenForLookup(otherEntry.accessToken),
    );
    expect(otherAccess).toBeDefined();
  });

  test("falls back to the full client+user scope when the replayed row carries no lineage key", async ({
    makeUser,
  }) => {
    const user = await makeUser();
    await makePublicClient(CIMD_CLIENT_ID);
    const replayed = await seedGrant({
      clientId: CIMD_CLIENT_ID,
      userId: user.id,
      referenceId: null,
      revoked: true,
    });
    const otherGrant = await seedGrant({
      clientId: CIMD_CLIENT_ID,
      userId: user.id,
      referenceId: "mcp-resource:profile-2",
    });

    advancePastGraceWindow();
    const outcome = await shieldRefreshTokenGrant({
      refreshToken: replayed.refreshToken,
      clientId: CIMD_CLIENT_ID,
      clientSecret: undefined,
    });

    expect(outcome.action).toBe("respond");
    // Without a referenceId or sessionId on the replayed row there is no
    // lineage to narrow to — the scope widens to better-auth's original
    // (client, user) pair.
    expect(await grantStillExists(replayed.refreshToken)).toBe(false);
    expect(await grantStillExists(otherGrant.refreshToken)).toBe(false);
  });

  test("requires the confidential client's secret before serving a replay", async ({
    makeUser,
    makeOrganization,
  }) => {
    const user = await makeUser();
    const organization = await makeOrganization();
    const { oauthClient, clientSecret } = await McpOauthClientModel.create({
      organizationId: organization.id,
      name: "Confidential MCP client",
      grantType: "authorization_code",
      redirectUris: ["http://localhost:1455/callback"],
      authorId: user.id,
    });
    const grant = await seedGrant({
      clientId: oauthClient.clientId,
      userId: user.id,
      revoked: true,
    });

    const rejected = await shieldRefreshTokenGrant({
      refreshToken: grant.refreshToken,
      clientId: oauthClient.clientId,
      clientSecret: "wrong-secret",
    });
    expect(rejected.action).toBe("respond");
    if (rejected.action !== "respond") throw new Error("unreachable");
    expect(rejected.statusCode).toBe(401);
    expect(rejected.body.error).toBe("invalid_client");

    const accepted = await shieldRefreshTokenGrant({
      refreshToken: grant.refreshToken,
      clientId: oauthClient.clientId,
      clientSecret,
    });
    expect(accepted.action).toBe("respond");
    if (accepted.action !== "respond") throw new Error("unreachable");
    expect(accepted.statusCode).toBe(200);
  });
});

describe("shieldRevocationRequest", () => {
  test("revokes an active refresh token and its access tokens, idempotently", async ({
    makeUser,
  }) => {
    const user = await makeUser();
    await makePublicClient(CIMD_CLIENT_ID);
    const grant = await seedGrant({
      clientId: CIMD_CLIENT_ID,
      userId: user.id,
    });
    const otherGrant = await seedGrant({
      clientId: CIMD_CLIENT_ID,
      userId: user.id,
      referenceId: "mcp-resource:profile-2",
    });

    const first = await shieldRevocationRequest({
      token: grant.refreshToken,
      clientId: CIMD_CLIENT_ID,
      clientSecret: undefined,
    });
    expect(first).toEqual({ action: "respond", statusCode: 200, body: {} });

    const revokedRow = await OAuthRefreshTokenModel.getByTokenHash(
      OAuthRefreshTokenModel.hashTokenForLookup(grant.refreshToken),
    );
    expect(revokedRow?.revoked).not.toBeNull();
    const accessRow = await OAuthAccessTokenModel.getByTokenHash(
      OAuthAccessTokenModel.hashTokenForLookup(grant.accessToken),
    );
    expect(accessRow).toBeUndefined();

    // Revoking the now-revoked token again is a 200 no-op — the case where
    // better-auth would delete the whole (client, user) family.
    const second = await shieldRevocationRequest({
      token: grant.refreshToken,
      clientId: CIMD_CLIENT_ID,
      clientSecret: undefined,
    });
    expect(second).toEqual({ action: "respond", statusCode: 200, body: {} });
    expect(await grantStillExists(otherGrant.refreshToken)).toBe(true);
  });

  test("responds 200 to an unknown token without forwarding", async () => {
    const outcome = await shieldRevocationRequest({
      token: "never-issued",
      clientId: CIMD_CLIENT_ID,
      clientSecret: undefined,
    });
    expect(outcome).toEqual({ action: "respond", statusCode: 200, body: {} });
  });

  test("forwards an access-token revocation to better-auth", async ({
    makeUser,
  }) => {
    const user = await makeUser();
    await makePublicClient(CIMD_CLIENT_ID);
    const grant = await seedGrant({
      clientId: CIMD_CLIENT_ID,
      userId: user.id,
    });

    const outcome = await shieldRevocationRequest({
      token: grant.accessToken,
      clientId: CIMD_CLIENT_ID,
      clientSecret: undefined,
    });
    expect(outcome).toEqual({ action: "forward" });
  });

  test("ignores a revocation from a client the token is not bound to", async ({
    makeUser,
  }) => {
    const user = await makeUser();
    await makePublicClient(CIMD_CLIENT_ID);
    await makePublicClient(OTHER_CLIENT_ID);
    const grant = await seedGrant({
      clientId: CIMD_CLIENT_ID,
      userId: user.id,
    });

    const outcome = await shieldRevocationRequest({
      token: grant.refreshToken,
      clientId: OTHER_CLIENT_ID,
      clientSecret: undefined,
    });
    expect(outcome).toEqual({ action: "respond", statusCode: 200, body: {} });

    const row = await OAuthRefreshTokenModel.getByTokenHash(
      OAuthRefreshTokenModel.hashTokenForLookup(grant.refreshToken),
    );
    expect(row?.revoked).toBeNull();
  });
});
