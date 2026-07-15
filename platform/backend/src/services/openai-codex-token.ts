/**
 * ChatGPT/Codex OAuth token redemption for the OpenAI "ChatGPT subscription"
 * auth mode.
 *
 * Each user holds a long-lived ChatGPT `refresh_token` (obtained via the Codex
 * device flow — see routes/openai-codex-auth) which is NOT accepted by the Codex
 * backend directly. It is redeemed at `POST {issuer}/oauth/token` for a
 * short-lived (~1h) `access_token` used against
 * `https://chatgpt.com/backend-api/codex/responses`.
 *
 * The redemption sits in the LLM proxy hot path, so this manager caches access
 * tokens per llm_provider_api_keys row id (refreshing 60s before expiry) and
 * single-flights concurrent redemptions for the same key. Keying by the row id —
 * not by the refresh token — keeps secret material out of cache keys and keeps
 * the slot stable while the token rotates.
 *
 * OpenAI refresh tokens may ROTATE: a redemption can return a new refresh token.
 * The manager keeps the newest in memory and persists it back to the stored
 * provider key (re-encoding the ChatGPT-subscription credential with the same
 * account id) best-effort — the previously stored token stays valid until its
 * own expiry, so a failed write-back costs only longevity, never correctness.
 *
 * Mirrors services/microsoft-365-copilot-token; see there for the lineage-digest
 * rationale (dropping a cached token whose stored credential was replaced by a
 * reconnect to a different account).
 */
import { createHmac, randomBytes } from "node:crypto";
import { arch, platform, release } from "node:os";
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
import {
  decodeJwtClaims,
  decodeOpenAiCodexCredential,
  encodeOpenAiCodexCredential,
  type OpenAiCodexCredential,
} from "./openai-codex-credentials";

const MAX_CACHED_TOKENS = 1000;

class OpenAiCodexTokenManager {
  private tokenCache = new LRUCacheManager<CachedAccessToken>({
    maxSize: MAX_CACHED_TOKENS,
  });
  private inFlightRedemptions = new Map<string, Promise<string>>();
  private persistQueues = new Map<string, Promise<void>>();

  /**
   * Returns a valid Codex access token for the given stored refresh token,
   * redeeming (and caching) it if needed. Without a providerApiKeyId (key
   * validation before the row exists, model listing) every call redeems
   * directly and a rotated token is discarded.
   */
  async getAccessToken(params: {
    refreshToken: string;
    providerApiKeyId?: string;
    /**
     * The account id of the credential being redeemed. Used to guard rotated-
     * token persistence against a concurrent reconnect to a DIFFERENT account
     * under the same key row (see persistRotatedRefreshToken).
     */
    accountId?: string;
  }): Promise<string> {
    const { refreshToken, providerApiKeyId, accountId } = params;

    if (!providerApiKeyId) {
      const { accessToken } = await redeemWithOpenAi(refreshToken);
      return accessToken;
    }

    let cached = this.tokenCache.get(providerApiKeyId);
    if (
      cached &&
      !cached.knownRefreshTokenDigests.includes(hashToken(refreshToken))
    ) {
      // Stored secret was replaced under the same key row (reconnect to a
      // different account): serving the cached token would answer as the old
      // credential. Drop it and redeem with the caller's token.
      this.tokenCache.delete(providerApiKeyId);
      cached = undefined;
    }
    if (cached && cached.expiresAtMs - REFRESH_BUFFER_MS > Date.now()) {
      return cached.accessToken;
    }

    const inFlight = this.inFlightRedemptions.get(providerApiKeyId);
    if (inFlight) {
      return inFlight;
    }

    const redemption = this.redeemAndCache({
      refreshToken,
      providerApiKeyId,
      accountId,
      latestRefreshToken: cached?.latestRefreshToken,
      knownRefreshTokenDigests: cached?.knownRefreshTokenDigests ?? [],
    }).finally(() => {
      this.inFlightRedemptions.delete(providerApiKeyId);
    });
    this.inFlightRedemptions.set(providerApiKeyId, redemption);
    return redemption;
  }

  /**
   * Drops the cached access token for a provider key. Called when the Codex
   * backend rejects a cached token (revoked early) so the next request
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
    // Keep the rotated refresh token + lineage alive across eviction.
    this.tokenCache.set(providerApiKeyId, { ...cached, expiresAtMs: 0 });
  }

  private async redeemAndCache(params: {
    refreshToken: string;
    providerApiKeyId: string;
    accountId?: string;
    latestRefreshToken?: string;
    knownRefreshTokenDigests: string[];
  }): Promise<string> {
    const {
      refreshToken,
      providerApiKeyId,
      accountId,
      latestRefreshToken,
      knownRefreshTokenDigests,
    } = params;

    // Prefer the most recently rotated refresh token; fall back to the stored
    // one only when we have never rotated in this process. If an in-memory
    // `latestRefreshToken` is itself rejected, we intentionally do NOT retry with
    // the stored `refreshToken`: OpenAI rotates the refresh token on every
    // redemption and invalidates its predecessor, so the older stored token is
    // necessarily already dead. Surfacing the 401 (which prompts a reconnect) is
    // correct rather than masking it with a guaranteed-stale retry.
    const { accessToken, expiresAtMs, rotatedRefreshToken } =
      await redeemWithOpenAi(latestRefreshToken ?? refreshToken);

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
      Math.max(expiresAtMs - Date.now(), 0) + ROTATED_TOKEN_RETENTION_MS,
    );

    if (rotatedRefreshToken && rotatedRefreshToken !== refreshToken) {
      this.queuePersist(providerApiKeyId, rotatedRefreshToken, accountId);
    }

    return accessToken;
  }

  private queuePersist(
    providerApiKeyId: string,
    newRefreshToken: string,
    expectedAccountId: string | undefined,
  ) {
    const tail = this.persistQueues.get(providerApiKeyId) ?? Promise.resolve();
    const next = tail
      .then(() =>
        this.persistRotatedRefreshToken(
          providerApiKeyId,
          newRefreshToken,
          expectedAccountId,
        ),
      )
      .catch((error) => {
        logger.warn(
          { providerApiKeyId, error },
          "[OpenAiCodex] failed to persist rotated refresh token",
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
    expectedAccountId: string | undefined,
  ): Promise<void> {
    const keyRow = await LlmProviderApiKeyModel.findById(providerApiKeyId);
    if (!keyRow?.secretId) {
      return;
    }
    const storedValue = await getSecretValueForLlmProviderApiKey(
      keyRow.secretId,
    );
    if (storedValue === undefined) {
      logger.warn(
        { providerApiKeyId },
        "[OpenAiCodex] skipping rotated refresh token persistence: stored secret value is unreadable",
      );
      return;
    }
    if (isVaultReference(storedValue)) {
      logger.warn(
        { providerApiKeyId },
        "[OpenAiCodex] skipping rotated refresh token persistence for vault-referenced key",
      );
      return;
    }
    const existing = decodeOpenAiCodexCredential(storedValue);
    if (!existing) {
      // The stored secret is no longer a ChatGPT-subscription credential (e.g.
      // reconnected as a plain API key). Don't overwrite it.
      return;
    }
    if (
      expectedAccountId !== undefined &&
      existing.accountId !== expectedAccountId
    ) {
      // The key row was reconnected to a DIFFERENT ChatGPT account between this
      // rotation and its persist. The rotated token belongs to the previous
      // account; writing it would pair the old account's refresh token with the
      // new account's id (a durable cross-account mismatch). Skip the write.
      logger.warn(
        { providerApiKeyId },
        "[OpenAiCodex] skipping rotated refresh token persistence: stored credential now belongs to a different account",
      );
      return;
    }
    await secretManager().updateSecret(keyRow.secretId, {
      apiKey: encodeOpenAiCodexCredential({
        refreshToken: newRefreshToken,
        accountId: existing.accountId,
      }),
    });
  }
}

/** @public — exercised directly by unit tests (cache/single-flight/rotation) */
export const openAiCodexTokenManager = new OpenAiCodexTokenManager();

/**
 * Wraps fetch so every Codex request carries a fresh short-lived access token
 * (redeemed from the stored refresh token) plus the ChatGPT identity headers the
 * Codex backend requires. A 401 on a cached access token invalidates it and
 * retries exactly once.
 *
 * Redemption failures are returned as a synthetic OpenAI-shaped error Response
 * rather than thrown, so the OpenAI SDK surfaces the real status/message instead
 * of a generic connection error.
 */
export function createOpenAiCodexFetch(params: {
  credential: OpenAiCodexCredential | undefined;
  providerApiKeyId?: string;
  sessionId: string;
  innerFetch?: FetchLike;
}): FetchLike {
  const { credential, providerApiKeyId, sessionId, innerFetch } = params;
  const baseFetch: FetchLike = innerFetch ?? fetch;

  return async (input, init) => {
    if (!credential) {
      return baseFetch(input, init);
    }

    const doFetch = async (accessToken: string) => {
      const headers = new Headers(init?.headers);
      // The Codex backend authenticates with the OAuth access token, never the
      // inbound placeholder key — strip and replace.
      headers.set("authorization", `Bearer ${accessToken}`);
      headers.set("chatgpt-account-id", credential.accountId);
      headers.set("originator", config.llm.openai.codex.originator);
      headers.set("OpenAI-Beta", "responses=experimental");
      // Match OpenCode's Codex request identity: `session-id` (hyphen) and a
      // real User-Agent instead of undici's default.
      headers.set("session-id", sessionId);
      headers.set("User-Agent", CODEX_USER_AGENT);
      return baseFetch(input, { ...init, headers });
    };

    let accessToken: string;
    try {
      accessToken = await openAiCodexTokenManager.getAccessToken({
        refreshToken: credential.refreshToken,
        providerApiKeyId,
        accountId: credential.accountId,
      });
    } catch (error) {
      return redemptionErrorResponse(error);
    }
    const response = await doFetch(accessToken);

    const bodyIsReplayable =
      init?.body === undefined || typeof init.body === "string";
    if (response.status === 401 && bodyIsReplayable) {
      await response.body?.cancel();
      if (providerApiKeyId) {
        openAiCodexTokenManager.invalidate(providerApiKeyId, accessToken);
      }
      let freshAccessToken: string;
      try {
        freshAccessToken = await openAiCodexTokenManager.getAccessToken({
          refreshToken: credential.refreshToken,
          providerApiKeyId,
          accountId: credential.accountId,
        });
      } catch (error) {
        return redemptionErrorResponse(error);
      }
      return doFetch(freshAccessToken);
    }

    return response;
  };
}

/**
 * Exchanges an authorization code (+ PKCE verifier) from the completed Codex
 * device flow for the OAuth token set. Used only by the device-auth poll route.
 */
export async function exchangeOpenAiCodexAuthCode(params: {
  code: string;
  codeVerifier: string;
  redirectUri: string;
}): Promise<{ refreshToken: string; idToken: string }> {
  const { code, codeVerifier, redirectUri } = params;
  const { issuer, clientId } = config.llm.openai.codex;

  const response = await fetch(`${issuer}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: clientId,
      code_verifier: codeVerifier,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    logger.warn(
      { status: response.status, ...oauthErrorLogFields(body) },
      "[OpenAiCodex] authorization code exchange failed",
    );
    throw new ApiError(
      502,
      `ChatGPT sign-in token exchange failed with status ${response.status}`,
    );
  }

  const payload = (await response.json()) as {
    access_token?: string;
    refresh_token?: string;
    id_token?: string;
  };
  if (!payload.refresh_token || !payload.id_token) {
    throw new ApiError(
      502,
      "ChatGPT sign-in returned an unexpected token payload",
    );
  }
  return { refreshToken: payload.refresh_token, idToken: payload.id_token };
}

/**
 * Extracts only the OAuth `error`/`error_description` from an OpenAI error body
 * for logging; the raw body (which can carry account details) is never logged.
 */
export function oauthErrorLogFields(body: string): {
  oauthError?: string;
  oauthErrorDescription?: string;
} {
  try {
    const parsed = JSON.parse(body) as {
      error?: unknown;
      error_description?: unknown;
    };
    return {
      oauthError: typeof parsed.error === "string" ? parsed.error : undefined,
      oauthErrorDescription:
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
  latestRefreshToken?: string;
  knownRefreshTokenDigests: string[];
}

const REFRESH_BUFFER_MS = 60 * 1000;
const ROTATED_TOKEN_RETENTION_MS = 24 * 60 * 60 * 1000;
const KNOWN_REFRESH_TOKEN_LIMIT = 8;
/** Fallback access-token lifetime when neither the JWT nor the response says. */
const DEFAULT_ACCESS_TOKEN_TTL_MS = 60 * 60 * 1000;

/**
 * Identifies Archestra to the Codex backend the way OpenCode identifies itself —
 * `<originator>/<version> (<platform> <release>; <arch>)`. A real User-Agent
 * (not undici's default) also avoids Cloudflare bot blocks on chatgpt.com. The
 * product token derives from the `originator` config so an override flows here.
 */
const CODEX_USER_AGENT = `${config.llm.openai.codex.originator}/${config.api.version} (${platform()} ${release()}; ${arch()})`;

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

// Per-process HMAC key for `knownRefreshTokenDigests`. Regenerated on every
// module load, so cached lineage digests intentionally do not survive a restart
// — after a restart the first refresh simply re-redeems and repopulates the
// digest set. This mirrors the Microsoft/GitHub Copilot token managers.
const LINEAGE_HMAC_KEY = randomBytes(32);

// Digests a refresh token for `knownRefreshTokenDigests`. The digest is never
// stored, persisted, or compared against anything outside this process, so a
// slow password KDF (bcrypt/scrypt/argon2) would only add latency to the proxy
// hot path. HMAC with a per-process key (rather than bare SHA-256) means an
// observer of a heap dump can't confirm a guessed token offline.
function hashToken(token: string): string {
  // codeql[js/insufficient-password-hash] HMACs a high-entropy OAuth refresh token for ephemeral lineage tracking, not password verification.
  return createHmac("sha256", LINEAGE_HMAC_KEY).update(token).digest("hex");
}

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
 * Redeems a ChatGPT refresh token for a Codex access token. Pure network call;
 * caching/single-flighting/rotation persistence live in the manager.
 */
async function redeemWithOpenAi(refreshToken: string): Promise<{
  accessToken: string;
  expiresAtMs: number;
  rotatedRefreshToken?: string;
}> {
  const { issuer, clientId } = config.llm.openai.codex;

  const response = await fetch(`${issuer}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: clientId,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    logger.warn(
      { status: response.status, ...oauthErrorLogFields(body) },
      "[OpenAiCodex] refresh token redemption failed",
    );
    // OpenAI reports expired/revoked/reused refresh tokens as 400/401.
    if (response.status === 400 || response.status === 401) {
      throw new ApiError(
        401,
        "ChatGPT sign-in has expired or been revoked. Reconnect your ChatGPT account to keep using your Codex subscription.",
      );
    }
    throw new ApiError(
      502,
      `ChatGPT token redemption failed with status ${response.status}`,
    );
  }

  const payload = (await response.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
  };
  if (!payload.access_token) {
    throw new ApiError(
      502,
      "ChatGPT token redemption returned an unexpected payload",
    );
  }

  return {
    accessToken: payload.access_token,
    expiresAtMs: accessTokenExpiryMs(payload.access_token, payload.expires_in),
    rotatedRefreshToken: payload.refresh_token,
  };
}

/**
 * Determines when a Codex access token expires: prefer the JWT `exp` claim (the
 * access token is a JWT), fall back to the response `expires_in`, then to a
 * conservative default.
 */
function accessTokenExpiryMs(
  accessToken: string,
  expiresIn: number | undefined,
): number {
  const exp = jwtExpMs(accessToken);
  if (exp !== undefined) {
    return exp;
  }
  if (typeof expiresIn === "number") {
    return Date.now() + expiresIn * 1000;
  }
  return Date.now() + DEFAULT_ACCESS_TOKEN_TTL_MS;
}

function jwtExpMs(jwt: string): number | undefined {
  const exp = decodeJwtClaims(jwt)?.exp;
  return typeof exp === "number" ? exp * 1000 : undefined;
}
