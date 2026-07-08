import { randomInt, timingSafeEqual } from "node:crypto";
import { hashOauthClientSecret } from "@/auth/oauth-client-secret";
import logger from "@/logging";
import {
  OAuthAccessTokenModel,
  OAuthClientModel,
  OAuthRefreshTokenModel,
} from "@/models";

/**
 * Shield in front of better-auth's refresh-token reuse detection.
 *
 * better-auth rotates refresh tokens (each refresh revokes the presented token
 * and mints a new one) and treats any replay of a revoked token as theft: it
 * deletes EVERY access + refresh token for the (client_id, user_id) pair
 * ("family invalidation", RFC 9700 §4.14). Because MCP clients registered via
 * CIMD share one client_id product-wide (the metadata URL), that scope wipes
 * all of a user's grants across every MCP server entry and device at once —
 * and benign replays are routine: a backend restart severs all connections
 * simultaneously, so a client whose token-exchange response was lost mid-
 * flight, or a second process holding the same stored refresh token, replays
 * the rotated token within seconds. One replay then forces interactive
 * re-auth for every entry.
 *
 * This module intercepts the two replay-sensitive endpoints before they reach
 * better-auth:
 *
 * - {@link shieldRefreshTokenGrant}: a replay inside a short grace window is
 *   treated as the rotation race it is — a fresh token pair is re-issued for
 *   the same grant and better-auth is never consulted. A replay beyond the
 *   window is still treated as a theft signal, but invalidation is scoped to
 *   the replayed grant's lineage instead of the whole (client, user) family.
 * - {@link shieldRevocationRequest}: RFC 7009 revocation of a refresh token is
 *   handled here in full (idempotently — revoking an already-revoked token is
 *   a 200 no-op, where better-auth would family-invalidate).
 */

/**
 * How long after rotation a replayed refresh token is treated as a benign
 * race rather than theft. Mirrors the bounded "reuse interval" pattern of
 * major OAuth providers.
 *
 * @public — exercised by oauth-refresh-replay.test.ts (knip --production ignores tests)
 */
export const REFRESH_TOKEN_REUSE_GRACE_MS = 60_000;

type OAuthEndpointInterception =
  | { action: "forward" }
  | { action: "respond"; statusCode: number; body: Record<string, unknown> };

/**
 * Decide how the token endpoint should handle a `refresh_token` grant.
 * Returns `forward` for every case better-auth handles without family
 * invalidation; intercepts only replays of revoked tokens.
 */
export async function shieldRefreshTokenGrant(params: {
  refreshToken: string | undefined;
  clientId: string | undefined;
  clientSecret: string | undefined;
}): Promise<OAuthEndpointInterception> {
  const { refreshToken, clientId } = params;
  if (!refreshToken || !clientId) {
    // Missing parameters — better-auth rejects these before its revoked-token
    // branch, so forwarding cannot trigger family invalidation.
    return { action: "forward" };
  }

  const row = await OAuthRefreshTokenModel.getByTokenHash(
    OAuthRefreshTokenModel.hashTokenForLookup(refreshToken),
  );
  // Every early return below matches a better-auth check that runs BEFORE its
  // revoked-token branch (not found → invalid_grant, client mismatch →
  // invalid_client, expired → invalid_grant), so forwarding is nuke-safe.
  if (!row || row.clientId !== clientId || row.expiresAt < new Date()) {
    return { action: "forward" };
  }
  if (!row.revoked) {
    // Active token — normal rotation, better-auth's job.
    return { action: "forward" };
  }

  // Replayed (already-rotated) refresh token: never forward past this point,
  // or better-auth deletes the whole (client, user) token family.
  if (!(await authenticateShieldedClient(clientId, params.clientSecret))) {
    return {
      action: "respond",
      statusCode: 401,
      body: {
        error: "invalid_client",
        error_description: "client authentication failed",
      },
    };
  }

  const revokedAgoMs = Date.now() - row.revoked.getTime();
  if (revokedAgoMs <= REFRESH_TOKEN_REUSE_GRACE_MS) {
    const body = await reissueTokenPair(row);
    logger.warn(
      { clientId, userId: row.userId, revokedAgoMs },
      "[oauth-refresh-replay] refresh token replayed within the reuse grace window — re-issuing a fresh pair for the same grant instead of invalidating the token family",
    );
    return { action: "respond", statusCode: 200, body };
  }

  const { accessTokensDeleted, refreshTokensDeleted, scope } =
    await invalidateGrantLineage(row);
  logger.warn(
    {
      clientId,
      userId: row.userId,
      revokedAgoMs,
      scope,
      accessTokensDeleted,
      refreshTokensDeleted,
    },
    "[oauth-refresh-replay] refresh token replayed outside the grace window — invalidated the grant lineage (scoped, not the whole client+user family)",
  );
  return {
    action: "respond",
    statusCode: 400,
    body: {
      error: "invalid_grant",
      error_description: "refresh token reuse detected",
    },
  };
}

/**
 * Decide how an RFC 7009 revocation request should be handled. Refresh tokens
 * are revoked here in full; access tokens and unknown-to-us tokens follow the
 * returned action (`forward` only for tokens better-auth can revoke without
 * family invalidation).
 */
export async function shieldRevocationRequest(params: {
  token: string | undefined;
  clientId: string | undefined;
  clientSecret: string | undefined;
}): Promise<OAuthEndpointInterception> {
  const { token, clientId } = params;
  if (!token) {
    // RFC 7009 §2.1 requires `token`; better-auth rejects the request without
    // touching any token row.
    return { action: "forward" };
  }

  const row = await OAuthRefreshTokenModel.getByTokenHash(
    OAuthRefreshTokenModel.hashTokenForLookup(token),
  );
  if (!row) {
    const accessToken = await OAuthAccessTokenModel.getByTokenHash(
      OAuthAccessTokenModel.hashTokenForLookup(token),
    );
    if (accessToken) {
      // Access-token revocation deletes just that row in better-auth — safe.
      return { action: "forward" };
    }
    // Unknown token: RFC 7009 §2.2 — respond 200 without acting. better-auth
    // would 400, and a replayed-then-family-deleted token would land here.
    return { action: "respond", statusCode: 200, body: {} };
  }

  if (!clientId || row.clientId !== clientId) {
    // RFC 7009 treats a token the client is not entitled to revoke like an
    // invalid token: 200 without acting.
    logger.warn(
      { presentedClientId: clientId, userId: row.userId },
      "[oauth-refresh-replay] revocation request for a refresh token bound to a different client — ignored",
    );
    return { action: "respond", statusCode: 200, body: {} };
  }
  if (!(await authenticateShieldedClient(clientId, params.clientSecret))) {
    return {
      action: "respond",
      statusCode: 401,
      body: {
        error: "invalid_client",
        error_description: "client authentication failed",
      },
    };
  }

  // Revoke race-safely; on a lost race (or an already-revoked token) another
  // revocation has already done the work — idempotent 200, never the
  // family invalidation better-auth performs on this path.
  const revoked = await OAuthRefreshTokenModel.revokeByIdWhenActive(row.id);
  const accessTokensDeleted = await OAuthAccessTokenModel.deleteByRefreshIds([
    row.id,
  ]);
  logger.info(
    {
      clientId,
      userId: row.userId,
      alreadyRevoked: !revoked,
      accessTokensDeleted,
    },
    "[oauth-refresh-replay] refresh token revoked via RFC 7009 revocation",
  );
  return { action: "respond", statusCode: 200, body: {} };
}

// === Internal helpers ===

type RefreshTokenRow = NonNullable<
  Awaited<ReturnType<typeof OAuthRefreshTokenModel.getByTokenHash>>
>;

/** better-auth's default opaque token lifetimes (not overridden in config). */
const ACCESS_TOKEN_TTL_SECONDS = 3600;
const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;

/**
 * Authenticate the client presenting a replayed token. Public clients (no
 * stored secret — all DCR/CIMD MCP clients) pass on client_id alone, matching
 * better-auth's own bar. Confidential clients must present the secret whose
 * hash better-auth stored at registration.
 */
async function authenticateShieldedClient(
  clientId: string,
  clientSecret: string | undefined,
): Promise<boolean> {
  const client = await OAuthClientModel.findByClientId(clientId);
  // A refresh row's client_id FK cascades on client deletion, so the client
  // row exists whenever the token row does; treat a miss as unauthenticated.
  if (!client) {
    return false;
  }
  const stored = client.clientSecret;
  if (!stored || stored === "none") {
    return true;
  }
  if (!clientSecret) {
    return false;
  }
  const presented = Buffer.from(hashOauthClientSecret(clientSecret));
  const expected = Buffer.from(stored);
  return (
    presented.length === expected.length && timingSafeEqual(presented, expected)
  );
}

/**
 * Re-issue a fresh access + refresh pair for the grant a replayed-in-grace
 * refresh token belongs to, copying the grant's identity (user, client,
 * scopes, resource binding, session) from the revoked row. The revoked row
 * itself stays revoked; repeated replays keep working only while the grace
 * window lasts.
 */
async function reissueTokenPair(
  row: RefreshTokenRow,
): Promise<Record<string, unknown>> {
  const now = Date.now();
  const accessToken = generateOpaqueToken();
  const refreshToken = generateOpaqueToken();
  const scopes = row.scopes ?? [];
  const expiresAtSeconds = Math.floor(now / 1000) + ACCESS_TOKEN_TTL_SECONDS;

  const refreshRow = await OAuthRefreshTokenModel.create({
    tokenHash: OAuthRefreshTokenModel.hashTokenForLookup(refreshToken),
    clientId: row.clientId,
    userId: row.userId,
    sessionId: row.sessionId,
    referenceId: row.referenceId,
    authTime: row.authTime,
    scopes,
    expiresAt: new Date(now + REFRESH_TOKEN_TTL_SECONDS * 1000),
  });
  await OAuthAccessTokenModel.create({
    tokenHash: OAuthAccessTokenModel.hashTokenForLookup(accessToken),
    clientId: row.clientId,
    userId: row.userId,
    sessionId: row.sessionId,
    referenceId: row.referenceId,
    refreshId: refreshRow.id,
    scopes,
    expiresAt: new Date(expiresAtSeconds * 1000),
  });

  return {
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: ACCESS_TOKEN_TTL_SECONDS,
    expires_at: expiresAtSeconds,
    refresh_token: refreshToken,
    scope: scopes.join(" "),
  };
}

/**
 * Delete the replayed grant's lineage: refresh rows for the same
 * (client, user) narrowed by the row's referenceId (per-resource grants) or
 * sessionId, plus the access tokens minted from them. Only when the row
 * carries neither does this widen to the full (client, user) pair —
 * better-auth's original scope.
 */
async function invalidateGrantLineage(row: RefreshTokenRow): Promise<{
  accessTokensDeleted: number;
  refreshTokensDeleted: number;
  scope: "referenceId" | "sessionId" | "client+user";
}> {
  const lineageKey = row.referenceId
    ? { scope: "referenceId" as const, referenceId: row.referenceId }
    : row.sessionId
      ? { scope: "sessionId" as const, sessionId: row.sessionId }
      : { scope: "client+user" as const };
  const { scope, ...filter } = lineageKey;
  const lineage = await OAuthRefreshTokenModel.listByClientAndUser({
    clientId: row.clientId,
    userId: row.userId,
    ...filter,
  });
  const ids = lineage.map((r) => r.id);
  // Access rows first: their refresh_id FK is ON DELETE SET NULL, so deleting
  // refresh rows first would orphan them out of reach.
  const accessTokensDeleted =
    await OAuthAccessTokenModel.deleteByRefreshIds(ids);
  const refreshTokensDeleted = await OAuthRefreshTokenModel.deleteByIds(ids);
  return { accessTokensDeleted, refreshTokensDeleted, scope };
}

/**
 * Mirror better-auth's opaque token format: 32 chars of [A-Za-z].
 */
function generateOpaqueToken(): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
  let token = "";
  for (let i = 0; i < 32; i++) {
    token += alphabet[randomInt(alphabet.length)];
  }
  return token;
}
