/**
 * xAI OAuth token redemption for the "SuperGrok" subscription auth mode.
 *
 * Each user holds a long-lived xAI `refresh_token` (obtained through the device
 * flow in routes/xai-subscription-auth). It is redeemed at the issuer's token
 * endpoint for a short-lived `access_token`, the bearer against xAI's CLI chat
 * proxy. xAI rotates the refresh token on every redemption and revokes the
 * whole token family when a spent token is presented again, so two redeemers
 * of one credential kill it.
 *
 * Invariants:
 * - The stored credential (the provider key's secret) is the source of truth.
 *   It carries the newest refresh token and the access token it last produced.
 * - One redeemer per key across the fleet: a cache miss takes a Postgres
 *   advisory lock scoped to the key id (models/subscription-credential-lock),
 *   re-reads the secret inside that transaction, adopts an access token another
 *   replica already stored, or redeems once and writes the rotation back before
 *   the lock is released. The write is synchronous: a rotation that is not yet
 *   persisted is one the next replica cannot see. A write-back that fails is
 *   retried briefly under the lock; past that, the rotation stays pending in
 *   this process, which never asks the issuer twice for one stored token and
 *   persists the successor on its next refresh. Another replica refreshing
 *   first would still present the spent token, so a secrets backend that stays
 *   down longer than that retry costs the family.
 * - A caller's copy of the credential is never redeemed. Replicas decode the
 *   secret through a process-local cache, so the copy a request carries can be
 *   older or newer than what this process last saw; only its `userId` is used,
 *   to detect a reconnect to a different account.
 * - Within one process, concurrent misses for the same key share one refresh,
 *   so a slow issuer costs one pooled connection per key, not one per request.
 *   The in-process cache is keyed by key id and checked against `userId`.
 *
 * services/openai-codex-token shares the credential shape but still refreshes
 * per process; it is the next candidate for the same lock.
 */
import { createHmac, randomBytes } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { ArchestraInternalErrorCode } from "@archestra/shared";
import { LRUCacheManager } from "@/cache-manager";
import config from "@/config";
import { isTransientDbError } from "@/database/retry";
import logger from "@/logging";
import LlmProviderApiKeyModel from "@/models/llm-provider-api-key";
import { withSubscriptionCredentialLock } from "@/models/subscription-credential-lock";
import { secretManager } from "@/secrets-manager";
import {
  ApiError,
  SECRETS_MANAGER_UNAVAILABLE_INTERNAL_CODE,
  type SecretReadOptions,
  type SelectSecret,
} from "@/types";
import { decodeJwtClaims } from "./openai-codex-credentials";
import { recordSubscriptionAuthenticationFailure } from "./subscription-authentication-status";
import {
  decodeXaiSubscriptionCredential,
  encodeXaiSubscriptionCredential,
  type XaiSubscriptionCredential,
} from "./xai-subscription-credentials";

// xAI's CLI chat proxy rejects a Grok CLI version below its minimum with
// HTTP 426, and xAI raises that minimum without notice. An hourly workflow
// proposes updates from the stable Grok CLI release channel.
const GROK_CLI_CLIENT_VERSION = "1.0.62";

const MAX_CACHED_TOKENS = 1000;

/** @public — independent instances exercise fleet-wide credential coordination in tests. */
export class XaiSubscriptionTokenManager {
  private tokenCache = new LRUCacheManager<CachedAccessToken>({
    maxSize: MAX_CACHED_TOKENS,
  });
  private validationRotations = new LRUCacheManager<XaiSubscriptionCredential>({
    maxSize: MAX_CACHED_TOKENS,
  });
  private inFlightRefreshes = new Map<string, InFlightRefresh>();
  private pendingRotations = new LRUCacheManager<PendingRotation>({
    maxSize: MAX_CACHED_TOKENS,
  });

  /**
   * Returns a valid xAI access token for a stored SuperGrok credential.
   *
   * Without `providerApiKeyId` (key validation before the row exists) the
   * redemption is uncached; the rotation and the access token it produced are
   * stashed so the create/reconnect routes persist a live credential, and a
   * second validation of the same body reuses that token instead of rotating
   * again.
   *
   * With `providerApiKeyId`: the fast path serves this process's cached token
   * while it is fresh and belongs to the caller's account. A miss joins the
   * refresh already in flight for the key or starts one (`refreshSharedToken`).
   * `staleAccessToken` is the token the caller just saw rejected; it is never
   * served again, even while it is still the stored one.
   */
  async getAccessToken(params: {
    credential: XaiSubscriptionCredential;
    providerApiKeyId?: string;
    staleAccessToken?: string;
  }): Promise<string> {
    const { credential, providerApiKeyId, staleAccessToken } = params;
    if (!providerApiKeyId) {
      const latest = this.latestKnownCredential(credential);
      if (
        freshStoredAccessToken(latest) &&
        latest.accessToken !== staleAccessToken
      ) {
        return latest.accessToken;
      }
      const result = await redeemWithXai(latest.refreshToken);
      const updated = {
        ...latest,
        refreshToken: result.rotatedRefreshToken ?? latest.refreshToken,
        accessToken: result.accessToken,
        accessTokenExpiresAtMs: result.expiresAtMs,
      };
      for (const refreshToken of [
        credential.refreshToken,
        latest.refreshToken,
        updated.refreshToken,
      ]) {
        this.validationRotations.set(
          hashToken(refreshToken),
          updated,
          VALIDATION_ROTATION_TTL_MS,
        );
      }
      return result.accessToken;
    }

    const cached = this.tokenCache.get(providerApiKeyId);
    if (
      cached?.userId === credential.userId &&
      cached.expiresAtMs - cached.refreshBufferMs > Date.now() &&
      cached.accessToken !== staleAccessToken
    ) {
      return cached.accessToken;
    }

    // One refresh per key per process: later misses wait for the same promise
    // instead of each parking a pooled connection behind the advisory lock.
    for (;;) {
      const inFlight = this.inFlightRefreshes.get(providerApiKeyId);
      if (inFlight?.userId !== credential.userId) {
        break;
      }
      const accessToken = await inFlight.promise;
      if (accessToken !== staleAccessToken) {
        return accessToken;
      }
      // The shared refresh adopted the very token this caller saw rejected (it
      // was still the stored one). That flight has left the map by the time
      // its promise settles; look again, so a newer flight is joined rather
      // than overlapped, and only then refresh on this caller's terms.
    }
    const flight: InFlightRefresh = {
      userId: credential.userId,
      promise: this.refreshSharedToken({
        credential,
        providerApiKeyId,
        staleAccessToken,
        cached,
      }).finally(() => {
        if (this.inFlightRefreshes.get(providerApiKeyId) === flight) {
          this.inFlightRefreshes.delete(providerApiKeyId);
        }
      }),
    };
    this.inFlightRefreshes.set(providerApiKeyId, flight);
    return flight.promise;
  }

  /**
   * The slow path: makes the stored credential this process's token source.
   *
   * 1. Re-read the secret without the process cache. When another replica has
   *    already stored a fresh access token, adopt it without taking the lock
   *    (the common case once one replica refreshed for the fleet).
   * 2. Otherwise take the per-key advisory lock, re-read the secret inside that
   *    transaction with its row locked (a concurrent reconnect waits), adopt a
   *    token that arrived meanwhile, or redeem the stored refresh token exactly
   *    once and persist the rotation and the new access token before the
   *    commit releases the lock.
   *
   * A rejected redemption (invalid_grant) marks the key as needing a reconnect
   * only when the token xAI rejected is still the stored one.
   */
  private async refreshSharedToken(params: {
    credential: XaiSubscriptionCredential;
    providerApiKeyId: string;
    staleAccessToken?: string;
    cached: CachedAccessToken | undefined;
  }): Promise<string> {
    const { credential, providerApiKeyId, staleAccessToken, cached } = params;
    const row = await LlmProviderApiKeyModel.findById(providerApiKeyId);
    if (row?.provider !== "xai" || !row.secretId) {
      throw unreadableCredentialError();
    }
    const secretId = row.secretId;
    const adoptable = (stored: XaiSubscriptionCredential) =>
      freshStoredAccessToken(stored) &&
      stored.accessToken !== staleAccessToken &&
      // The token this process already holds, expired by its own buffer, is
      // not news: nobody refreshed yet, so this caller must.
      (stored.accessToken !== cached?.accessToken ||
        cached.expiresAtMs - cached.refreshBufferMs > Date.now());

    const peeked = await readStoredCredential({
      secretId,
      callerUserId: credential.userId,
      options: { skipCache: true },
    });
    if (adoptable(peeked)) {
      return this.rememberSharedToken(providerApiKeyId, cached, {
        credential: peeked,
        digests: [hashToken(peeked.refreshToken)],
      });
    }

    // The lock helper retries its callback on transient database failures, and
    // a redemption cannot be repeated: the refresh token is spent the moment
    // xAI answers, whether or not that answer gets persisted. So the issuer is
    // called at most once per stored token by this process, whatever the
    // database does: a successful redemption is kept in `pendingRotations`
    // until its write-back commits (a retry, or the next refresh, persists it
    // instead of redeeming again), a failed one is remembered for the rest of
    // this call (a retry does not present the token again), and neither an
    // issuer failure nor a write-back failure is thrown through the
    // transaction: the retry wrapper classifies network errors by shape, not
    // by source, and would hold the lock through its whole backoff. A
    // write-back that fails in an external secrets backend (the transaction is
    // still usable) is repeated a few times under the lock first, so a blip
    // there does not release the lock with the successor held only here.
    // Any write-back failure that is not repeated, or still fails after those
    // attempts, a statement the database rejected included, is carried out as
    // `persistFailure`; the transaction then ends without the write. Only a
    // lost connection reaches the lock helper's whole-callback retry, through
    // the failed commit, and the pending rotation makes that re-run safe.
    let issuerFailure:
      | { error: unknown; rejected: XaiSubscriptionCredential | undefined }
      | undefined;
    let persistFailure: { cause: unknown } | undefined;
    let rotationSkipped = false;
    const result = await withSubscriptionCredentialLock({
      provider: "xai",
      providerApiKeyId,
      run: async (transaction): Promise<SharedTokenResult | undefined> => {
        const stored = await readStoredCredential({
          secretId,
          callerUserId: credential.userId,
          options: { skipCache: true, transaction, forUpdate: true },
        });
        if (adoptable(stored)) {
          return {
            credential: stored,
            digests: [hashToken(stored.refreshToken)],
          };
        }
        if (issuerFailure) {
          // An earlier attempt of this callback already failed at the issuer;
          // this attempt exists because the database failed, so nothing new
          // is learnt by asking again.
          return undefined;
        }
        const pending = this.pendingRotations.get(providerApiKeyId);
        let redeemed: Redemption | undefined;
        // What to present if a redemption is needed: the stored token, or the
        // live successor of a pending rotation whose access token has already
        // expired while it waited (its predecessor, the stored one, is spent).
        let redeemFrom = stored.refreshToken;
        if (pending?.refreshToken === stored.refreshToken) {
          if (
            pending.redeemed.expiresAtMs - Date.now() >
            STORED_ACCESS_TOKEN_MIN_REMAINING_MS
          ) {
            redeemed = pending.redeemed;
          } else {
            redeemFrom =
              pending.redeemed.rotatedRefreshToken ?? stored.refreshToken;
          }
        } else if (pending) {
          // The stored credential moved on (a reconnect) while this rotation
          // waited to be persisted: it descends from a dead family now.
          this.pendingRotations.delete(providerApiKeyId);
        }
        if (!redeemed) {
          try {
            redeemed = await redeemWithXai(redeemFrom);
          } catch (error) {
            issuerFailure = {
              error,
              rejected:
                error instanceof ApiError &&
                error.internalCode ===
                  ArchestraInternalErrorCode.ProviderAuthRequired
                  ? stored
                  : undefined,
            };
            return undefined;
          }
          this.pendingRotations.set(
            providerApiKeyId,
            { refreshToken: stored.refreshToken, redeemed },
            PENDING_ROTATION_TTL_MS,
          );
        }
        const { vaultReference, ...storedCredential } = stored;
        const updated = {
          ...storedCredential,
          refreshToken: redeemed.rotatedRefreshToken ?? stored.refreshToken,
          accessToken: redeemed.accessToken,
          accessTokenExpiresAtMs: redeemed.expiresAtMs,
        };
        if (vaultReference) {
          // Release-branch rule: a vault-referenced row is never overwritten
          // with OAuth material. The rotation stays pending in this process,
          // which keeps refreshing from its own successor.
          rotationSkipped = true;
          logger.warn(
            { providerApiKeyId },
            "[XaiSubscription] skipping rotated refresh token persistence for vault-referenced key",
          );
        } else {
          let persisted: SelectSecret | null = null;
          for (let attempt = 1; ; attempt++) {
            try {
              persisted = await secretManager().updateSecret(
                secretId,
                { apiKey: encodeXaiSubscriptionCredential(updated) },
                { transaction },
              );
              break;
            } catch (error) {
              if (
                attempt < WRITE_BACK_ATTEMPTS &&
                retryableWriteBackFailure(error)
              ) {
                await sleep(WRITE_BACK_RETRY_DELAY_MS);
                continue;
              }
              // Whatever threw, from the secrets backend or the database, stays
              // here: the caller gets a 502 and the rotation stays pending.
              persistFailure = { cause: error };
              return undefined;
            }
          }
          if (!persisted) {
            persistFailure = { cause: undefined };
            return undefined;
          }
        }
        return {
          credential: updated,
          digests: [
            hashToken(stored.refreshToken),
            ...(redeemFrom === stored.refreshToken
              ? []
              : [hashToken(redeemFrom)]),
            hashToken(updated.refreshToken),
          ],
        };
      },
    });
    if (result) {
      if (result.digests.length > 1 && !rotationSkipped) {
        this.pendingRotations.delete(providerApiKeyId);
        // The transactional write bypassed this process's secret cache; read
        // the committed row once so per-request decodes stop carrying the
        // spent refresh token.
        await secretManager().getSecret(secretId, { skipCache: true });
      }
      return this.rememberSharedToken(providerApiKeyId, cached, result);
    }
    if (issuerFailure) {
      if (issuerFailure.rejected) {
        await this.recordAuthenticationFailure({
          providerApiKeyId,
          credential: issuerFailure.rejected,
        });
      }
      throw issuerFailure.error;
    }
    const error = new ApiError(
      502,
      "Could not persist the refreshed SuperGrok credential",
    );
    if (persistFailure?.cause !== undefined) {
      error.cause = persistFailure.cause;
    }
    throw error;
  }

  /** Caches the shared token for the key and returns it. */
  private rememberSharedToken(
    providerApiKeyId: string,
    cached: CachedAccessToken | undefined,
    result: SharedTokenResult,
  ): string {
    const expiresAtMs = result.credential.accessTokenExpiresAtMs as number;
    const accessToken = result.credential.accessToken as string;
    const lifetimeMs = expiresAtMs - Date.now();
    // A TTL of 0 means "never expires" to the cache: a token that expired while
    // it was being persisted is not cached at all.
    if (lifetimeMs > 0) {
      this.tokenCache.set(
        providerApiKeyId,
        {
          accessToken,
          expiresAtMs,
          refreshBufferMs: refreshBufferFor(lifetimeMs),
          userId: result.credential.userId,
          knownRefreshTokenDigests: appendKnownDigests(
            cached?.userId === result.credential.userId &&
              result.digests.some((digest) =>
                cached.knownRefreshTokenDigests.includes(digest),
              )
              ? cached.knownRefreshTokenDigests
              : [],
            result.digests,
          ),
        },
        lifetimeMs,
      );
    }
    return accessToken;
  }

  /**
   * The newest credential this process knows to descend from `credential`
   * through ID-less validation redemptions: the credential itself when no
   * rotation was observed. Routes call this after validation to persist a
   * credential whose refresh token is still alive.
   */
  latestKnownCredential(
    credential: XaiSubscriptionCredential,
  ): XaiSubscriptionCredential {
    let current = credential;
    for (let hop = 0; hop < KNOWN_REFRESH_TOKEN_LIMIT; hop++) {
      const next = this.validationRotations.get(
        hashToken(current.refreshToken),
      );
      if (!next || next.userId !== credential.userId) break;
      const previousRefreshToken = current.refreshToken;
      current = { ...current, ...next };
      if (next.refreshToken === previousRefreshToken) break;
    }
    return current;
  }

  /**
   * Drops this process's cached token for a key after xAI rejected it. With
   * `staleAccessToken`, only that exact token is dropped: a late 401 for an
   * older token must not evict one another request already refreshed.
   */
  invalidate(providerApiKeyId: string, staleAccessToken?: string): void {
    const cached = this.tokenCache.get(providerApiKeyId);
    if (
      cached &&
      (staleAccessToken === undefined ||
        cached.accessToken === staleAccessToken)
    ) {
      this.tokenCache.delete(providerApiKeyId);
    }
  }

  async recordAuthenticationFailure(params: {
    providerApiKeyId: string;
    credential: XaiSubscriptionCredential;
    accessToken?: string;
  }): Promise<void> {
    const { providerApiKeyId, credential } = params;
    const callerDigest = hashToken(credential.refreshToken);
    const cached = this.tokenCache.get(providerApiKeyId);
    const lineage =
      cached?.userId === credential.userId &&
      (cached.knownRefreshTokenDigests.includes(callerDigest) ||
        cached.accessToken === params.accessToken)
        ? cached.knownRefreshTokenDigests
        : [callerDigest];
    await recordSubscriptionAuthenticationFailure({
      providerApiKeyId,
      provider: "xai",
      skipCache: true,
      matchesCredential(value) {
        const stored = decodeXaiSubscriptionCredential(value);
        return Boolean(
          stored &&
            stored.userId === credential.userId &&
            lineage.includes(hashToken(stored.refreshToken)),
        );
      },
    });
  }
}

export const xaiSubscriptionTokenManager = new XaiSubscriptionTokenManager();

/**
 * Wraps fetch so every xAI request carries a fresh short-lived access token
 * redeemed from the stored refresh token. A 401 on a cached access token
 * invalidates it and retries exactly once.
 *
 * Redemption failures are returned as a synthetic OpenAI-shaped error Response
 * rather than thrown, so the OpenAI SDK surfaces the real status/message instead
 * of a generic connection error.
 */
export function createXaiSubscriptionFetch(params: {
  credential: XaiSubscriptionCredential | undefined;
  providerApiKeyId?: string;
  innerFetch?: FetchLike;
}): FetchLike {
  const { credential, providerApiKeyId, innerFetch } = params;
  const baseFetch: FetchLike = innerFetch ?? fetch;

  return async (input, init) => {
    if (!credential) {
      return baseFetch(input, init);
    }

    if (!isBearerTargetAllowed(input)) {
      // Per-key base URLs are user-supplied, so an arbitrary override must never
      // receive somebody's subscription bearer. Fail closed rather than send it.
      logger.warn(
        { providerApiKeyId },
        "[XaiSubscription] refusing to send a subscription bearer to a non-xAI base URL",
      );
      return redemptionErrorResponse(
        new ApiError(
          400,
          "SuperGrok credentials can only be used against the configured xAI subscription endpoint — remove the per-key base URL override or use an API key instead.",
        ),
      );
    }

    const modelOverride = await xaiModelOverrideFromRequest(input, init);
    const doFetch = async (accessToken: string) => {
      const headers = new Headers(
        input instanceof Request ? input.headers : undefined,
      );
      new Headers(init?.headers).forEach((value, name) => {
        headers.set(name, value);
      });
      // xAI authenticates with the OAuth access token, never the inbound
      // placeholder key. The proxy also requires the identity/client headers
      // used by xAI's first-party Grok client; set them after caller headers so
      // a per-key override cannot spoof another account.
      headers.set("authorization", `Bearer ${accessToken}`);
      for (const [name, value] of Object.entries(
        xaiSubscriptionSessionHeaders(credential),
      )) {
        headers.set(name, value);
      }
      // These are inference-only proxy headers. `/models` uses the shared
      // session identity headers above but does not need proxy middleware or
      // model-routing overrides.
      headers.set("x-authenticateresponse", "authenticate-response");
      if (modelOverride) {
        headers.set("x-grok-model-override", modelOverride);
      }
      // Never replay OAuth/session headers to a redirect target. The initial
      // origin is pinned above; redirects must be surfaced as upstream errors.
      return baseFetch(input, { ...init, headers, redirect: "manual" });
    };

    let accessToken: string;
    try {
      accessToken = await xaiSubscriptionTokenManager.getAccessToken({
        credential,
        providerApiKeyId,
      });
    } catch (error) {
      // A rejected redemption is already recorded against the key by the
      // manager; its other 401s (replaced credential, another account) must
      // not flag the key.
      return redemptionErrorResponse(error);
    }
    const response = await doFetch(accessToken);

    const bodyIsReplayable =
      init?.body === undefined || typeof init.body === "string";
    if (response.status === 401 && bodyIsReplayable) {
      await response.body?.cancel();
      if (providerApiKeyId) {
        xaiSubscriptionTokenManager.invalidate(providerApiKeyId, accessToken);
      }
      let freshAccessToken: string;
      try {
        freshAccessToken = await xaiSubscriptionTokenManager.getAccessToken({
          credential,
          providerApiKeyId,
          staleAccessToken: accessToken,
        });
      } catch (error) {
        return redemptionErrorResponse(error);
      }
      const retried = await doFetch(freshAccessToken);
      if (providerApiKeyId && retried.status === 401) {
        await xaiSubscriptionTokenManager.recordAuthenticationFailure({
          providerApiKeyId,
          credential,
          accessToken: freshAccessToken,
        });
      }
      return retried;
    }

    return response;
  };
}

/**
 * The issuer's OAuth endpoints, read once from its OIDC discovery document and
 * cached for the process lifetime.
 *
 * Discovery is used rather than hardcoded paths because xAI publishes one, but
 * the discovered URLs are still validated against the configured issuer (same
 * scheme, same host or a sibling under its parent domain) — a discovery document
 * is fetched over the network, and an unvalidated endpoint would be an open
 * redirect for the client id and, on the token endpoint, the refresh token.
 */
export async function xaiOauthEndpoints(): Promise<XaiOauthEndpoints> {
  const { issuer } = config.llm.xai.subscription;
  const cached = discoveryCache.get(issuer);
  if (cached) {
    return cached;
  }
  const pending =
    inFlightDiscovery.get(issuer) ??
    discoverXaiOauthEndpoints(issuer)
      .then((endpoints) => {
        discoveryCache.set(issuer, endpoints);
        return endpoints;
      })
      .finally(() => {
        inFlightDiscovery.delete(issuer);
      });
  inFlightDiscovery.set(issuer, pending);
  return pending;
}

/**
 * Extracts only the OAuth `error`/`error_description` from an xAI error body for
 * logging; the raw body (which can carry account details) is never logged.
 */
export function xaiOauthErrorLogFields(body: string): {
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

/**
 * True when a URL is on the configured xAI session-proxy origin — the only origin an
 * SuperGrok subscription bearer may be sent to. Shared by the proxy fetch
 * wrapper and the xai model fetcher so the fail-closed rule cannot drift
 * between the two.
 */
function isXaiSubscriptionBearerOrigin(url: string): boolean {
  try {
    return (
      new URL(url).origin ===
      new URL(config.llm.xai.subscription.baseUrl).origin
    );
  } catch {
    return false;
  }
}

/** Required companion headers for xAI OAuth-session requests. */
export function xaiSubscriptionSessionHeaders(
  credential: XaiSubscriptionCredential,
): Record<string, string> {
  const clientVersion =
    config.llm.xai.subscription.clientVersion ?? GROK_CLI_CLIENT_VERSION;
  return {
    "X-XAI-Token-Auth": "xai-grok-cli",
    "x-userid": credential.userId,
    ...(credential.email ? { "x-email": credential.email } : {}),
    "x-grok-client-version": clientVersion,
    "x-grok-client-identifier": "archestra",
    "x-grok-client-mode": "headless",
    "user-agent": `archestra/${config.api.version} grok-build/${clientVersion}`,
  };
}

// ===== Internal helpers =====

type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

async function xaiModelOverrideFromRequest(
  input: string | URL | Request,
  init?: RequestInit,
): Promise<string | undefined> {
  let body: string | undefined;
  if (typeof init?.body === "string") {
    body = init.body;
  } else if (input instanceof Request) {
    try {
      body = await input.clone().text();
    } catch {
      return undefined;
    }
  }
  if (!body) {
    return undefined;
  }
  try {
    const model = (JSON.parse(body) as { model?: unknown }).model;
    return typeof model === "string" && model.length > 0 ? model : undefined;
  } catch {
    return undefined;
  }
}

interface XaiOauthEndpoints {
  deviceAuthorizationEndpoint: string;
  tokenEndpoint: string;
}

interface InFlightRefresh {
  /** Account the refresh is for; a caller for another account starts its own. */
  userId: string;
  promise: Promise<string>;
}

type Redemption = Awaited<ReturnType<typeof redeemWithXai>>;

/** A redemption this process made whose write-back has not committed yet. */
interface PendingRotation {
  /** The stored refresh token it was redeemed from; it applies while that is still the stored one. */
  refreshToken: string;
  redeemed: Redemption;
}

/** What a shared refresh produced: the credential to serve and the refresh-token lineage it spans. */
interface SharedTokenResult {
  credential: XaiSubscriptionCredential;
  digests: string[];
}

interface CachedAccessToken {
  accessToken: string;
  expiresAtMs: number;
  /** How early to redeem again, derived from this token's own lifetime. */
  refreshBufferMs: number;
  userId: string;
  knownRefreshTokenDigests: string[];
}

/**
 * Ceiling on how early a token is refreshed before it expires. Deliberately NOT
 * the Codex manager's flat 60s: xAI access tokens are short-lived and their
 * lifetime is not a documented constant, so the buffer is derived per token
 * (below) instead of assumed.
 */
const MAX_REFRESH_BUFFER_MS = 5 * 60 * 1000;
/**
 * Fraction of a token's own lifetime to keep as headroom. Bounding the buffer by
 * a fraction as well as an absolute ceiling is what makes a short lifetime safe:
 * a flat buffer at or above the lifetime would re-redeem on every single request.
 */
const REFRESH_BUFFER_FRACTION = 0.25;
const KNOWN_REFRESH_TOKEN_LIMIT = 8;
/** Fallback access-token lifetime when the response omits `expires_in`. */
const DEFAULT_ACCESS_TOKEN_TTL_MS = 60 * 60 * 1000;
/**
 * Least remaining lifetime for a stored access token to be served instead of
 * refreshed; see `freshStoredAccessToken`.
 */
const STORED_ACCESS_TOKEN_MIN_REMAINING_MS = 30 * 1000;
/**
 * How long an ID-less validation rotation stays retrievable. Creation persists
 * it within the same request, so minutes of headroom is plenty.
 */
const VALIDATION_ROTATION_TTL_MS = 15 * 60 * 1000;
/**
 * How long a redeemed rotation that failed to persist is held for the next
 * refresh to write. Its predecessor is spent, so the successor is the only
 * live token of the family; a secrets backend that stays down this long has
 * cost the family anyway.
 */
const PENDING_ROTATION_TTL_MS = 60 * 60 * 1000;
/**
 * Attempts for the write-back under the lock when an external secrets backend
 * fails with a network-shaped error, and the pause between them. Short on
 * purpose: the lock and a pooled connection are held throughout.
 */
const WRITE_BACK_ATTEMPTS = 3;
const WRITE_BACK_RETRY_DELAY_MS = 250;

/**
 * Whether a failed write-back is worth repeating on the same transaction: a
 * transient failure wrapped by an external secrets backend (Vault), whose
 * database side has not run yet. A failure raised by the database itself has
 * broken the transaction, so repeating the statement on it cannot succeed;
 * the caller carries that one out of the callback on its first attempt.
 */
function retryableWriteBackFailure(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    error.internalCode === SECRETS_MANAGER_UNAVAILABLE_INTERNAL_CODE &&
    isTransientDbError(error)
  );
}

/** @public — exported for unit tests; the per-token refresh headroom. */
export function refreshBufferFor(lifetimeMs: number): number {
  if (!Number.isFinite(lifetimeMs) || lifetimeMs <= 0) {
    return 0;
  }
  return Math.min(MAX_REFRESH_BUFFER_MS, lifetimeMs * REFRESH_BUFFER_FRACTION);
}

const discoveryCache = new Map<string, XaiOauthEndpoints>();
const inFlightDiscovery = new Map<string, Promise<XaiOauthEndpoints>>();

async function discoverXaiOauthEndpoints(
  issuer: string,
): Promise<XaiOauthEndpoints> {
  const url = `${issuer.replace(/\/+$/, "")}/.well-known/openid-configuration`;
  let response: Response;
  try {
    response = await fetch(url, {
      signal: AbortSignal.timeout(20_000),
      headers: { accept: "application/json" },
      redirect: "manual",
    });
  } catch (error) {
    logger.error({ error }, "[XaiSubscription] OIDC discovery request failed");
    throw new ApiError(502, "Could not reach the xAI sign-in service");
  }
  if (!response.ok) {
    logger.error(
      { status: response.status },
      "[XaiSubscription] OIDC discovery returned an error",
    );
    throw new ApiError(502, "Could not reach the xAI sign-in service");
  }

  let payload: {
    device_authorization_endpoint?: unknown;
    token_endpoint?: unknown;
  };
  try {
    payload = (await response.json()) as typeof payload;
  } catch {
    throw new ApiError(
      502,
      "The xAI sign-in service returned an unexpected discovery document",
    );
  }

  const deviceAuthorizationEndpoint = validateDiscoveredEndpoint(
    payload.device_authorization_endpoint,
    issuer,
    "device_authorization_endpoint",
  );
  const tokenEndpoint = validateDiscoveredEndpoint(
    payload.token_endpoint,
    issuer,
    "token_endpoint",
  );
  return { deviceAuthorizationEndpoint, tokenEndpoint };
}

/**
 * Accepts a discovered endpoint only when it stays within the configured
 * issuer's own domain: identical scheme, and a host that is the issuer's host or
 * a sibling under its parent domain (so `auth.x.ai` may point at `api.x.ai`, but
 * never at another origin). An issuer host with fewer than three labels — a
 * local test server, or a bare two-label domain whose "parent" would be an
 * entire TLD — must match exactly, since it has no parent safe to widen to.
 */
function validateDiscoveredEndpoint(
  value: unknown,
  issuer: string,
  field: string,
): string {
  if (typeof value !== "string" || !value) {
    throw new ApiError(
      502,
      `The xAI sign-in service published no ${field} — device sign-in is unavailable`,
    );
  }
  let endpointUrl: URL;
  let issuerUrl: URL;
  try {
    endpointUrl = new URL(value);
    issuerUrl = new URL(issuer);
  } catch {
    throw new ApiError(
      502,
      `The xAI sign-in service published an unusable ${field}`,
    );
  }

  const labels = issuerUrl.hostname.split(".");
  const parentDomain = labels.length > 2 ? labels.slice(1).join(".") : null;
  const hostAllowed =
    endpointUrl.hostname === issuerUrl.hostname ||
    (parentDomain !== null &&
      (endpointUrl.hostname === parentDomain ||
        endpointUrl.hostname.endsWith(`.${parentDomain}`)));

  if (endpointUrl.protocol !== issuerUrl.protocol || !hostAllowed) {
    logger.error(
      { field, endpointHost: endpointUrl.host, issuerHost: issuerUrl.host },
      "[XaiSubscription] discovery published an endpoint outside the issuer's domain",
    );
    throw new ApiError(
      502,
      `The xAI sign-in service published an out-of-domain ${field}`,
    );
  }
  return endpointUrl.toString();
}

/**
 * True when an outgoing request targets the configured xAI API base URL. Per-key
 * base URL overrides are user-supplied, so the subscription bearer is only ever
 * attached to the operator-configured origin.
 */
function isBearerTargetAllowed(input: string | URL | Request): boolean {
  const requestUrl =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url;
  return isXaiSubscriptionBearerOrigin(requestUrl);
}

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
// digest set. This mirrors the Codex / Copilot token managers.
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
          // Preserve the Archestra-normalized classification across the
          // synthetic HTTP hop; the adapter's extractInternalCode relays it.
          ...(error.internalCode ? { internal_code: error.internalCode } : {}),
        },
      },
      { status: error.statusCode },
    );
  }
  throw error;
}

/**
 * Redeems an xAI refresh token for an access token. Pure network call;
 * caching/single-flighting/rotation persistence live in the manager.
 */
async function redeemWithXai(refreshToken: string): Promise<{
  accessToken: string;
  expiresAtMs: number;
  rotatedRefreshToken?: string;
}> {
  const { clientId } = config.llm.xai.subscription;
  const { tokenEndpoint } = await xaiOauthEndpoints();

  let response: Response;
  try {
    response = await fetch(tokenEndpoint, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded",
      },
      signal: AbortSignal.timeout(20_000),
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: clientId,
      }),
      redirect: "manual",
    });
  } catch (error) {
    // No answer from the issuer: whether it consumed the token is unknown, so
    // the caller gets an outage, not a reconnect prompt, and does not retry.
    logger.warn(
      { error },
      "[XaiSubscription] refresh token redemption request failed",
    );
    throw new ApiError(502, "Could not reach the xAI sign-in service");
  }

  let body: string;
  try {
    body = await response.text();
  } catch (error) {
    // The issuer answered, so the refresh token is spent, but the answer did
    // not arrive whole and the rotation in it is lost. An outage status keeps
    // callers from retrying the request against a token that is now revoked.
    logger.warn(
      { status: response.status, error },
      "[XaiSubscription] refresh token redemption response was cut off",
    );
    throw new ApiError(
      502,
      "The xAI sign-in service returned an incomplete response",
    );
  }

  if (!response.ok) {
    logger.warn(
      { status: response.status, ...xaiOauthErrorLogFields(body) },
      "[XaiSubscription] refresh token redemption failed",
    );
    // Expired/revoked/reused refresh tokens come back as 400/401. The internal
    // code rides the error envelope so the chat error mapper renders the
    // reconnect card instead of a generic invalid-key message.
    if (response.status === 400 || response.status === 401) {
      throw new ApiError(
        401,
        "SuperGrok sign-in has expired or been revoked. Reconnect your Grok account to keep using your SuperGrok subscription.",
        ArchestraInternalErrorCode.ProviderAuthRequired,
      );
    }
    throw new ApiError(
      502,
      `xAI token redemption failed with status ${response.status}`,
    );
  }

  let payload: {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
  };
  try {
    payload = JSON.parse(body) as typeof payload;
  } catch {
    throw new ApiError(
      502,
      "xAI token redemption returned an unexpected payload",
    );
  }
  if (!payload.access_token) {
    throw new ApiError(
      502,
      "xAI token redemption returned an unexpected payload",
    );
  }

  return {
    accessToken: payload.access_token,
    expiresAtMs: xaiAccessTokenExpiryMs(
      payload.access_token,
      payload.expires_in,
    ),
    rotatedRefreshToken: payload.refresh_token,
  };
}

/**
 * Determines when an xAI access token expires: prefer the JWT `exp` claim when
 * the token is one, fall back to the response `expires_in`, then to a
 * conservative default. Mirrors the Codex token manager — the real lifetime is
 * not a documented constant, and over-estimating it would cost every request
 * in the gap a 401 + re-redemption round-trip.
 */
export function xaiAccessTokenExpiryMs(
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

/**
 * Whether a stored credential's access token is worth serving. The stored
 * credential does not carry the token's original lifetime, so the proportional
 * refresh buffer the in-process cache uses cannot apply; a flat floor keeps a
 * token about to expire from being adopted only to fail upstream.
 */
function freshStoredAccessToken(
  credential: XaiSubscriptionCredential,
): credential is XaiSubscriptionCredential & {
  accessToken: string;
  accessTokenExpiresAtMs: number;
} {
  return Boolean(
    credential.accessToken &&
      (credential.accessTokenExpiresAtMs ?? 0) - Date.now() >
        STORED_ACCESS_TOKEN_MIN_REMAINING_MS,
  );
}

/**
 * Reads and decodes the SuperGrok credential behind a key's secret. Throws the
 * reconnect-shaped 401 when the secret is gone, is no longer a SuperGrok
 * credential, or belongs to another account than the caller's: the caller's
 * identity headers would not match that account's token.
 */
async function readStoredCredential(params: {
  secretId: string;
  callerUserId: string;
  options: SecretReadOptions;
}): Promise<XaiSubscriptionCredential & { vaultReference: boolean }> {
  const secret = await secretManager().getSecret(
    params.secretId,
    params.options,
  );
  const stored = decodeXaiSubscriptionCredential(
    typeof secret?.secret?.apiKey === "string"
      ? secret.secret.apiKey
      : undefined,
  );
  if (!stored) {
    throw unreadableCredentialError();
  }
  if (stored.userId !== params.callerUserId) {
    throw new ApiError(
      401,
      "SuperGrok account has changed. Reload the credential before retrying.",
      ArchestraInternalErrorCode.ProviderAuthRequired,
    );
  }
  // The secret ROW's storage flag, not the resolved value: resolution
  // dereferences BYOS Vault references, so only the row says whether a
  // write-back would overwrite a reference with raw OAuth material.
  return { ...stored, vaultReference: secret?.isByosVault === true };
}

function unreadableCredentialError(): ApiError {
  return new ApiError(
    401,
    "SuperGrok credential is unreadable or has been replaced. Reconnect your Grok account.",
    ArchestraInternalErrorCode.ProviderAuthRequired,
  );
}
