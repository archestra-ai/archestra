/**
 * Microsoft 365 Copilot (Entra ID) token redemption.
 *
 * The Microsoft 365 Copilot Chat API only supports delegated auth, so each
 * user holds a long-lived Entra ID refresh token (obtained via the Entra
 * device flow) which is NOT accepted by Microsoft Graph directly. It must be
 * redeemed at `POST /{tenant}/oauth2/v2.0/token` for a short-lived (~1h)
 * access token used against https://graph.microsoft.com.
 *
 * The redemption sits in the LLM proxy hot path, so this manager caches
 * access tokens per llm_provider_api_keys row id (refreshing 60s before
 * expiry) and single-flights concurrent redemptions for the same key. Keying
 * by the row id — not by (a digest of) the refresh token — keeps secret
 * material out of cache keys entirely and keeps the cache slot stable while
 * the underlying token rotates. Callers without a row id (key validation
 * before the row exists, model listing) redeem directly, uncached.
 *
 * Unlike GitHub's OAuth tokens, Entra refresh tokens ROTATE: a redemption may
 * return a new refresh token. The manager keeps the newest one in memory
 * (`latestRefreshToken`) and persists it back to the stored provider key
 * best-effort — Entra keeps the previous refresh token valid until its own
 * expiry, so a failed write-back degrades longevity (the ~90-day inactivity
 * window keeps sliding only if the stored token is refreshed), never
 * per-request correctness.
 *
 * Because the cache key is not derived from the credential, each entry tracks
 * the refresh tokens it has seen (`knownRefreshTokenDigests`, HMAC digests —
 * the raw tokens are never retained for this). A caller presenting a token
 * outside that lineage means the stored secret was replaced (e.g. the key row
 * reconnected to a different account); the entry is dropped so the old
 * credential's access token can never be served for the new one.
 */
import { createHmac, randomBytes } from "node:crypto";
import { isVaultReference } from "@archestra/shared";
import { LRUCacheManager } from "@/cache-manager";
import config from "@/config";
import logger from "@/logging";
import LlmProviderApiKeyModel from "@/models/llm-provider-api-key";
import {
  getSecretValueForLlmProviderApiKey,
  secretManager,
} from "@/secrets-manager";
import { ApiError } from "@/types";

/**
 * Delegated scopes the Microsoft 365 Copilot Chat API requires — ALL of the
 * Graph read scopes must be consented for the API to accept the token —
 * plus `offline_access` so the device flow issues a refresh token.
 * Shared by the device-flow start route and the refresh-token redemption so
 * the two can never drift.
 */
export const MICROSOFT_365_COPILOT_OAUTH_SCOPES = [
  "offline_access",
  "openid",
  "profile",
  "https://graph.microsoft.com/Sites.Read.All",
  "https://graph.microsoft.com/Mail.Read",
  "https://graph.microsoft.com/People.Read.All",
  "https://graph.microsoft.com/OnlineMeetingTranscript.Read.All",
  "https://graph.microsoft.com/Chat.Read",
  "https://graph.microsoft.com/ChannelMessage.Read.All",
  "https://graph.microsoft.com/ExternalItem.Read.All",
].join(" ");

/**
 * Tenant-scoped Entra OAuth base (`{authBaseUrl}/{tenantId}`), with any
 * trailing slash on the configured base URL stripped so path concatenation
 * never produces a double slash. Shared with the device-flow auth routes so
 * the two token-endpoint constructions can never drift.
 */
export function microsoft365CopilotOauthBaseUrl(): string {
  const { authBaseUrl, tenantId } = config.llm["microsoft-365-copilot"];
  return `${authBaseUrl.replace(/\/+$/, "")}/${tenantId}`;
}

// Not in the internal-helpers section: consts are not hoisted, and this one is
// read by a field initializer when the singleton is constructed at module eval.
const MAX_CACHED_TOKENS = 1000;

class Microsoft365CopilotTokenManager {
  private tokenCache = new LRUCacheManager<CachedAccessToken>({
    maxSize: MAX_CACHED_TOKENS,
  });
  private inFlightRedemptions = new Map<string, Promise<string>>();
  /**
   * Tail of the pending persist chain per provider-key id. Serializes secret
   * writes so two concurrent rotations for the same key can't interleave.
   */
  private persistQueues = new Map<string, Promise<void>>();

  /**
   * Returns a valid Graph access token for the given stored refresh token,
   * redeeming (and caching) it if needed.
   */
  async getAccessToken(params: {
    refreshToken: string;
    /**
     * Id of the llm_provider_api_keys row holding the refresh token — also
     * the cache/single-flight key. When given, redemptions are cached and a
     * rotated refresh token is persisted back to that key's secret. Without
     * it (key validation before the row exists, model listing) every call
     * redeems directly and a rotated token is discarded — Entra keeps the
     * submitted token valid until its own expiry, so only the longevity
     * refresh of the stored key is lost, never correctness.
     */
    providerApiKeyId?: string;
  }): Promise<string> {
    const { refreshToken, providerApiKeyId } = params;

    if (!providerApiKeyId) {
      const { accessToken } = await redeemWithEntra(refreshToken);
      return accessToken;
    }

    let cached = this.tokenCache.get(providerApiKeyId);
    if (
      cached &&
      !cached.knownRefreshTokenDigests.includes(hashToken(refreshToken))
    ) {
      // The caller's token is outside this entry's lineage: the stored secret
      // was replaced under the same key row. Serving the cached access token
      // would answer as the OLD credential's identity — drop the entry and
      // redeem with the caller's token instead.
      this.tokenCache.delete(providerApiKeyId);
      cached = undefined;
    }
    if (cached && cached.expiresAtMs - REFRESH_BUFFER_MS > Date.now()) {
      return cached.accessToken;
    }

    const inFlight = this.inFlightRedemptions.get(providerApiKeyId);
    if (inFlight) {
      // Joining is safe even though the in-flight redemption may be using a
      // different refresh token than this caller supplied: the lineage check
      // above guarantees every joiner holds a token from the same credential,
      // and redeemAndCache prefers the entry's latest rotated token anyway.
      return inFlight;
    }

    const redemption = this.redeemAndCache({
      refreshToken,
      providerApiKeyId,
      // A stale cache entry may hold a newer rotated token than the caller's.
      latestRefreshToken: cached?.latestRefreshToken,
      knownRefreshTokenDigests: cached?.knownRefreshTokenDigests ?? [],
    }).finally(() => {
      this.inFlightRedemptions.delete(providerApiKeyId);
    });
    this.inFlightRedemptions.set(providerApiKeyId, redemption);
    return redemption;
  }

  /**
   * Drops the cached access token for a provider key. Called when Graph
   * rejects a cached access token (e.g. revoked early) so the next request
   * re-redeems. When `staleAccessToken` is given, only that exact token is
   * evicted — a concurrent 401 handler must not throw away a token another
   * request already refreshed.
   */
  invalidate(providerApiKeyId: string, staleAccessToken?: string): void {
    const cached = this.tokenCache.get(providerApiKeyId);
    if (!cached) {
      return;
    }
    if (
      staleAccessToken !== undefined &&
      cached.accessToken !== staleAccessToken
    ) {
      return;
    }
    // Keep the rotated refresh token and lineage alive across the eviction:
    // re-inserting an already-expired entry preserves them for the next
    // redemption while failing the freshness check above.
    this.tokenCache.set(providerApiKeyId, { ...cached, expiresAtMs: 0 });
  }

  private async redeemAndCache(params: {
    refreshToken: string;
    providerApiKeyId: string;
    latestRefreshToken?: string;
    knownRefreshTokenDigests: string[];
  }): Promise<string> {
    const {
      refreshToken,
      providerApiKeyId,
      latestRefreshToken,
      knownRefreshTokenDigests,
    } = params;

    const { accessToken, expiresAtMs, rotatedRefreshToken } =
      await redeemWithEntra(latestRefreshToken ?? refreshToken);

    this.tokenCache.set(
      providerApiKeyId,
      {
        accessToken,
        expiresAtMs,
        latestRefreshToken: rotatedRefreshToken ?? latestRefreshToken,
        knownRefreshTokenDigests: appendKnownDigests(knownRefreshTokenDigests, [
          hashToken(refreshToken),
          rotatedRefreshToken && hashToken(rotatedRefreshToken),
        ]),
      },
      // Freshness is enforced via expiresAtMs above; the LRU entry outlives
      // the access token so `latestRefreshToken` is still around for the next
      // redemption (it matters when persistence to the stored key fails).
      Math.max(expiresAtMs - Date.now(), 0) + ROTATED_TOKEN_RETENTION_MS,
    );

    if (rotatedRefreshToken && rotatedRefreshToken !== refreshToken) {
      this.queuePersist(providerApiKeyId, rotatedRefreshToken);
    }

    return accessToken;
  }

  private queuePersist(providerApiKeyId: string, newRefreshToken: string) {
    const tail = this.persistQueues.get(providerApiKeyId) ?? Promise.resolve();
    const next = tail
      .then(() =>
        this.persistRotatedRefreshToken(providerApiKeyId, newRefreshToken),
      )
      .catch((error) => {
        // Best-effort: the in-memory `latestRefreshToken` keeps serving, and
        // Entra accepts the previously stored token until its own expiry.
        logger.warn(
          { providerApiKeyId, error },
          "[Microsoft365Copilot] failed to persist rotated refresh token",
        );
      });
    this.persistQueues.set(providerApiKeyId, next);
    next.finally(() => {
      if (this.persistQueues.get(providerApiKeyId) === next) {
        this.persistQueues.delete(providerApiKeyId);
      }
    });
  }

  private async persistRotatedRefreshToken(
    providerApiKeyId: string,
    newRefreshToken: string,
  ): Promise<void> {
    const keyRow = await LlmProviderApiKeyModel.findById(providerApiKeyId);
    if (!keyRow?.secretId) {
      return;
    }
    const storedValue = await getSecretValueForLlmProviderApiKey(
      keyRow.secretId,
    );
    if (storedValue === undefined) {
      // Unreadable stored value (e.g. the secret vanished between the key
      // lookup and here): the vault-reference check below can't run, so skip
      // rather than overwrite an unknown target. Costs only longevity — the
      // in-memory latestRefreshToken keeps serving this process.
      logger.warn(
        { providerApiKeyId },
        "[Microsoft365Copilot] skipping rotated refresh token persistence: stored secret value is unreadable",
      );
      return;
    }
    if (isVaultReference(storedValue)) {
      // BYOS vault reference: the actual token lives in an external read-only
      // vault we must not (and cannot) overwrite.
      logger.warn(
        { providerApiKeyId },
        "[Microsoft365Copilot] skipping rotated refresh token persistence for vault-referenced key",
      );
      return;
    }
    await secretManager().updateSecret(keyRow.secretId, {
      apiKey: newRefreshToken,
    });
  }
}

/** @public — exercised directly by unit tests (cache/single-flight/rotation) */
export const microsoft365CopilotTokenManager =
  new Microsoft365CopilotTokenManager();

/**
 * Wraps fetch so every Microsoft Graph request carries a fresh short-lived
 * access token (redeemed from the stored Entra refresh token). A 401 on a
 * cached access token invalidates it and retries exactly once.
 *
 * Used by the microsoft-365-copilot proxy adapter's Graph client and the model
 * fetcher (the chat LLM client routes through the local proxy instead, so the
 * redemption happens exactly once — in the adapter).
 *
 * Redemption failures are returned as a synthetic error Response rather than
 * thrown: the adapter surfaces the real status and message through the
 * standard OpenAI-shaped provider error path instead of a generic
 * connection failure.
 */
export function createMicrosoft365CopilotFetch(params: {
  refreshToken: string | undefined;
  providerApiKeyId?: string;
  innerFetch?: FetchLike;
}): FetchLike {
  const { refreshToken, providerApiKeyId, innerFetch } = params;
  const baseFetch: FetchLike = innerFetch ?? fetch;

  return async (input, init) => {
    if (!refreshToken) {
      // Keyless calls cannot be redeemed; let Graph reject the request so the
      // standard provider error path reports it.
      return baseFetch(input, init);
    }

    const doFetch = async (accessToken: string) => {
      const headers = new Headers(init?.headers);
      headers.set("authorization", `Bearer ${accessToken}`);
      return baseFetch(input, { ...init, headers });
    };

    let accessToken: string;
    try {
      accessToken = await microsoft365CopilotTokenManager.getAccessToken({
        refreshToken,
        providerApiKeyId,
      });
    } catch (error) {
      return redemptionErrorResponse(error);
    }
    const response = await doFetch(accessToken);

    // A cached access token can be rejected before its reported expiry (e.g.
    // Conditional Access revocation). Re-redeem once; non-replayable bodies
    // are never produced by our Graph client (it serializes JSON strings).
    const bodyIsReplayable =
      init?.body === undefined || typeof init.body === "string";
    if (response.status === 401 && bodyIsReplayable) {
      await response.body?.cancel();
      if (providerApiKeyId) {
        // Without a key id nothing was cached — the retry below re-redeems.
        microsoft365CopilotTokenManager.invalidate(
          providerApiKeyId,
          accessToken,
        );
      }
      let freshAccessToken: string;
      try {
        freshAccessToken = await microsoft365CopilotTokenManager.getAccessToken(
          {
            refreshToken,
            providerApiKeyId,
          },
        );
      } catch (error) {
        return redemptionErrorResponse(error);
      }
      return doFetch(freshAccessToken);
    }

    return response;
  };
}

/**
 * Extracts only the OAuth `error` code and `error_description` from an Entra
 * error body for logging. Entra error bodies can carry tenant and account
 * details that don't belong in production logs, so the raw body is never
 * logged — an unparseable body yields no fields at all.
 */
export function entraErrorLogFields(body: string): {
  entraError?: string;
  entraErrorDescription?: string;
} {
  try {
    const parsed = JSON.parse(body) as {
      error?: unknown;
      error_description?: unknown;
    };
    return {
      entraError: typeof parsed.error === "string" ? parsed.error : undefined,
      entraErrorDescription:
        typeof parsed.error_description === "string"
          ? parsed.error_description.slice(0, 300)
          : undefined,
    };
  } catch {
    return {};
  }
}

// ===== Internal helpers =====

type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

interface CachedAccessToken {
  accessToken: string;
  expiresAtMs: number;
  /**
   * Newest rotated refresh token seen for this cache slot. Redemptions prefer
   * it over the caller's (stored) token so rotation keeps working even while
   * persistence to the stored key lags or fails. Deliberately kept raw: it is
   * fed back to the Entra token endpoint, so a digest cannot serve here.
   */
  latestRefreshToken?: string;
  /**
   * HMAC digests of the refresh tokens known to belong to this key row's
   * credential: every token a caller has presented plus every rotation Entra
   * returned. A caller token outside this lineage signals a replaced
   * credential (see getAccessToken). The lineage check is pure set
   * membership, so digests suffice — no reason to keep more raw secret
   * material in the cache than redemption itself needs.
   */
  knownRefreshTokenDigests: string[];
}

/** Refresh this long before the access token's reported expiry. */
const REFRESH_BUFFER_MS = 60 * 1000;

/** How long a cache entry outlives its access token (see set() call above). */
const ROTATED_TOKEN_RETENTION_MS = 24 * 60 * 60 * 1000;

/**
 * Cap on `knownRefreshTokenDigests`. Callers re-present the stored token on
 * every redemption and each redemption re-appends its digest (most-recent
 * last), so tokens still in active use never age out; only long-superseded
 * rotations do.
 */
const KNOWN_REFRESH_TOKEN_LIMIT = 8;

function appendKnownDigests(
  existing: string[],
  seen: Array<string | undefined>,
): string[] {
  const merged = [...existing];
  for (const digest of seen) {
    if (!digest) {
      continue;
    }
    const alreadyAt = merged.indexOf(digest);
    if (alreadyAt !== -1) {
      merged.splice(alreadyAt, 1);
    }
    merged.push(digest);
  }
  return merged.slice(-KNOWN_REFRESH_TOKEN_LIMIT);
}

// Per-process random key for the lineage-digest HMAC below. Regenerated on
// each boot — the digests live only in the in-memory cache, so a cold start
// on restart is fine.
const LINEAGE_HMAC_KEY = randomBytes(32);

// Digests a refresh token for `knownRefreshTokenDigests`. The digest is never
// stored, persisted, or compared against anything outside this process, so a
// slow password KDF (bcrypt/scrypt/argon2) would only add latency to the
// proxy hot path. HMAC with a per-process key (rather than bare SHA-256)
// means an observer of a heap dump can't confirm a guessed token offline.
function hashToken(token: string): string {
  // codeql[js/insufficient-password-hash] HMACs a high-entropy OAuth refresh token for ephemeral lineage tracking, not password verification.
  return createHmac("sha256", LINEAGE_HMAC_KEY).update(token).digest("hex");
}

/**
 * Converts a token-redemption ApiError into an OpenAI-shaped error Response so
 * SDK-style consumers raise a proper status error (no retries, real message).
 */
function redemptionErrorResponse(error: unknown): Response {
  if (error instanceof ApiError) {
    return Response.json(
      {
        error: {
          message: error.message,
          type: error.statusCode === 401 ? "authentication_error" : "api_error",
        },
      },
      { status: error.statusCode },
    );
  }
  throw error;
}

/**
 * Redeems an Entra refresh token for a Graph access token. Pure network call:
 * caching, single-flighting, and rotation persistence live in the manager.
 */
async function redeemWithEntra(refreshToken: string): Promise<{
  accessToken: string;
  expiresAtMs: number;
  rotatedRefreshToken?: string;
}> {
  const { clientId } = config.llm["microsoft-365-copilot"];

  const response = await fetch(
    `${microsoft365CopilotOauthBaseUrl()}/oauth2/v2.0/token`,
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        scope: MICROSOFT_365_COPILOT_OAUTH_SCOPES,
      }),
    },
  );

  if (!response.ok) {
    const body = await response.text();
    logger.warn(
      { status: response.status, ...entraErrorLogFields(body) },
      "[Microsoft365Copilot] refresh token redemption failed",
    );
    // Entra reports expired/revoked refresh tokens as 400 invalid_grant.
    if (response.status === 400 || response.status === 401) {
      throw new ApiError(
        401,
        "Microsoft sign-in has expired or been revoked. Reconnect your Microsoft account to keep using Microsoft 365 Copilot.",
      );
    }
    throw new ApiError(
      502,
      `Microsoft 365 Copilot token redemption failed with status ${response.status}`,
    );
  }

  const payload = (await response.json()) as {
    access_token?: string;
    expires_in?: number;
    refresh_token?: string;
  };
  if (!payload.access_token || typeof payload.expires_in !== "number") {
    throw new ApiError(
      502,
      "Microsoft 365 Copilot token redemption returned an unexpected payload",
    );
  }

  return {
    accessToken: payload.access_token,
    expiresAtMs: Date.now() + payload.expires_in * 1000,
    rotatedRefreshToken: payload.refresh_token,
  };
}
