import { randomInt } from "node:crypto";
import config from "@/config";
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
 * flight replays the rotated token within seconds. One replay then forces
 * interactive re-auth for every entry.
 *
 * The blast radius is a property of PUBLIC clients: only they share one
 * product-wide client_id (via CIMD), so their family spans every gateway and
 * device. Confidential clients each register a unique client_id, so
 * better-auth's family invalidation is naturally contained to that one client.
 * The shield therefore intervenes only for public clients and lets confidential
 * clients keep better-auth's authenticated path unchanged — which also keeps
 * all client-secret verification inside better-auth.
 *
 * This module guards the two replay-sensitive endpoints before they reach
 * better-auth:
 *
 * - {@link shieldRefreshTokenGrant}: for a public client, a replay inside a
 *   short grace window is treated as the rotation race it is — a fresh token
 *   pair is re-issued for the same grant. A replay beyond the window is still a
 *   theft signal, but invalidation is scoped to the replayed grant's lineage
 *   instead of the whole (client, user) family.
 * - {@link shieldRevocationRequest}: makes RFC 7009 revocation idempotent —
 *   revoking an already-revoked or unknown token is a 200 no-op, where
 *   better-auth would 400 and family-invalidate. Valid tokens forward to
 *   better-auth (which authenticates the client and revokes the single token).
 */

/**
 * How long after rotation a replayed refresh token is treated as a benign race
 * rather than theft, in milliseconds. Mirrors the bounded "reuse interval"
 * pattern of major OAuth providers. Configurable via
 * `ARCHESTRA_AUTH_REFRESH_TOKEN_REUSE_GRACE_SECONDS` (default 60s; 0 disables).
 *
 * @public — exercised by oauth-refresh-replay.test.ts (knip --production ignores tests)
 */
export function refreshTokenReuseGraceMs(): number {
  return config.auth.refreshTokenReuseGraceSeconds * 1000;
}

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

  // Replayed (already-rotated) refresh token. Only public clients suffer the
  // cross-gateway family wipe (shared CIMD client_id); a confidential client's
  // family is confined to its own unique client_id, so let better-auth handle
  // it — that also keeps client-secret verification inside better-auth. If the
  // client can't be resolved, treat it as public (fail safe: never forward a
  // replay into the family wipe).
  const client = await OAuthClientModel.findByClientId(clientId);
  const isConfidential =
    !!client?.clientSecret && client.clientSecret !== "none";
  if (isConfidential) {
    return { action: "forward" };
  }

  const revokedAgoMs = Date.now() - row.revoked.getTime();
  if (revokedAgoMs <= refreshTokenReuseGraceMs()) {
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
 * Decide how an RFC 7009 revocation request should be handled. Only the
 * already-revoked case is intercepted — the one input for which better-auth
 * family-invalidates — plus unknown tokens (RFC 7009 §2.2 wants a 200 no-op,
 * where better-auth returns 400). Everything else forwards to better-auth,
 * which authenticates the client and revokes the single token without touching
 * the family. Client-secret verification therefore stays inside better-auth.
 */
export async function shieldRevocationRequest(params: {
  token: string | undefined;
}): Promise<OAuthEndpointInterception> {
  const { token } = params;
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

  if (row.revoked) {
    // Already-revoked refresh token — the only revoke input better-auth
    // answers with family invalidation. RFC 7009: a no-op 200. Never forward.
    logger.info(
      { userId: row.userId },
      "[oauth-refresh-replay] revocation of an already-revoked refresh token — 200 no-op (not forwarded to better-auth's family invalidation)",
    );
    return { action: "respond", statusCode: 200, body: {} };
  }

  // Active refresh token — better-auth authenticates the client and revokes
  // just this token (no family invalidation on the happy path).
  return { action: "forward" };
}

// === Internal helpers ===

type RefreshTokenRow = NonNullable<
  Awaited<ReturnType<typeof OAuthRefreshTokenModel.getByTokenHash>>
>;

/** better-auth's default opaque token lifetimes (not overridden in config). */
const ACCESS_TOKEN_TTL_SECONDS = 3600;
const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;

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
