/**
 * xAI OAuth token redemption for the "SuperGrok" subscription auth
 * mode.
 *
 * Each user holds a long-lived xAI `refresh_token` (obtained via the device flow
 * — see routes/xai-subscription-auth) which is NOT accepted by api.x.ai directly.
 * It is redeemed at the issuer's token endpoint for a short-lived `access_token`
 * used as the bearer against xAI's OpenAI-compatible CLI chat proxy.
 *
 * The redemption sits in the LLM proxy hot path, so this manager caches access
 * tokens per llm_provider_api_keys row id and single-flights concurrent
 * redemptions for the same key. Keying by the row id — not by the refresh token —
 * keeps secret material out of cache keys and keeps the slot stable while the
 * token rotates.
 *
 * xAI refresh tokens may ROTATE: a redemption can return a new refresh token.
 * The manager keeps the newest in memory and persists it back to the stored
 * provider key best-effort — the previously stored token stays valid until its
 * own expiry, so a failed write-back costs only longevity, never correctness.
 *
 * Mirrors services/openai-codex-token; see there for the lineage-digest rationale
 * (dropping a cached token whose stored credential was replaced by a reconnect to
 * a different account).
 */
import { createHmac, randomBytes } from "node:crypto";
import { ArchestraInternalErrorCode } from "@archestra/shared";
import { LRUCacheManager } from "@/cache-manager";
import config from "@/config";
import logger from "@/logging";
import LlmProviderApiKeyModel from "@/models/llm-provider-api-key";
import SecretModel from "@/models/secret";
import {
  getSecretValueForLlmProviderApiKey,
  secretManager,
} from "@/secrets-manager";
import { ApiError } from "@/types";
import { trackBackgroundWork } from "@/utils/background-work";
import { decodeJwtClaims } from "./openai-codex-credentials";
import {
  decodeXaiSubscriptionCredential,
  encodeXaiSubscriptionCredential,
  type XaiSubscriptionCredential,
} from "./xai-subscription-credentials";

const MAX_CACHED_TOKENS = 1000;

class XaiSubscriptionTokenManager {
  private tokenCache = new LRUCacheManager<CachedAccessToken>({
    maxSize: MAX_CACHED_TOKENS,
  });
  private inFlightRedemptions = new Map<string, InFlightRedemption>();
  private persistQueues = new Map<string, Promise<void>>();
  /**
   * Rotations observed during ID-less redemptions (key validation before the
   * row exists), keyed by the digest of the token that was redeemed. The issuer
   * invalidates the predecessor on rotation, so discarding these would persist
   * an already-dead token at key creation. `latestKnownRefreshToken` lets the
   * create/reconnect routes re-encode the credential with the newest token
   * before writing the secret.
   */
  private validationRotations = new LRUCacheManager<string>({
    maxSize: MAX_CACHED_TOKENS,
  });

  /**
   * Returns a valid xAI access token for the given stored refresh token,
   * redeeming (and caching) it if needed. Without a providerApiKeyId (key
   * validation before the row exists) the redemption is uncached and any
   * rotated refresh token is stashed for `latestKnownRefreshToken`, so the
   * caller can persist the still-valid token instead of the dead predecessor.
   */
  async getAccessToken(params: {
    refreshToken: string;
    providerApiKeyId?: string;
  }): Promise<string> {
    const { refreshToken, providerApiKeyId } = params;

    if (!providerApiKeyId) {
      // Follow any rotation already observed for this token, so validating the
      // same credential twice in one process doesn't redeem a dead predecessor.
      const latestToken = this.latestKnownRefreshToken(refreshToken);
      const { accessToken, rotatedRefreshToken } =
        await redeemWithXai(latestToken);
      this.recordValidationRotation(latestToken, rotatedRefreshToken);
      return accessToken;
    }

    const callerDigest = hashToken(refreshToken);
    let cached = this.tokenCache.get(providerApiKeyId);
    if (cached && !cached.knownRefreshTokenDigests.includes(callerDigest)) {
      // Stored secret was replaced under the same key row (reconnect to a
      // different account): serving the cached token would answer as the old
      // credential. Drop it and redeem with the caller's token.
      this.tokenCache.delete(providerApiKeyId);
      cached = undefined;
    }
    if (cached && cached.expiresAtMs - cached.refreshBufferMs > Date.now()) {
      return cached.accessToken;
    }

    // Join an in-flight redemption only when the caller's token belongs to the
    // same credential lineage. A caller holding a DIFFERENT credential (the row
    // was reconnected to another account mid-flight) must not receive the old
    // account's bearer — it starts its own redemption and takes over the slot.
    const inFlight = this.inFlightRedemptions.get(providerApiKeyId);
    if (inFlight?.lineageDigests.has(callerDigest)) {
      return inFlight.promise;
    }

    const entry: InFlightRedemption = {
      lineageDigests: new Set([
        callerDigest,
        ...(cached?.knownRefreshTokenDigests ?? []),
      ]),
      promise: this.redeemAndCache({
        refreshToken,
        providerApiKeyId,
        latestRefreshToken: cached?.latestRefreshToken,
        knownRefreshTokenDigests: cached?.knownRefreshTokenDigests ?? [],
      }).finally(() => {
        // Identity-guarded: a takeover by a newer credential must not have its
        // map entry deleted by the superseded flight finishing later.
        if (this.inFlightRedemptions.get(providerApiKeyId) === entry) {
          this.inFlightRedemptions.delete(providerApiKeyId);
        }
      }),
    };
    this.inFlightRedemptions.set(providerApiKeyId, entry);
    return entry.promise;
  }

  /**
   * The newest refresh token this process knows to descend from
   * `refreshToken` via ID-less validation redemptions — `refreshToken` itself
   * when no rotation was observed. Routes call this after validation to
   * persist a credential whose token is still alive.
   */
  latestKnownRefreshToken(refreshToken: string): string {
    let current = refreshToken;
    // The chain is bounded: each hop is one observed rotation, and entries
    // never map a token to itself.
    for (let hop = 0; hop < KNOWN_REFRESH_TOKEN_LIMIT; hop++) {
      const next = this.validationRotations.get(hashToken(current));
      if (!next || next === current) {
        break;
      }
      current = next;
    }
    return current;
  }

  /**
   * Drops the cached access token for a provider key. Called when xAI rejects a
   * cached token (revoked early) so the next request re-redeems. When
   * `staleAccessToken` is given, only that exact token is evicted — a concurrent
   * 401 handler must not throw away a token another request already refreshed.
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
    // Keep the rotated refresh token + lineage alive across eviction, with an
    // explicit TTL — the cache's default (1h) would silently cut the retention
    // window redeemAndCache granted.
    this.tokenCache.set(
      providerApiKeyId,
      { ...cached, expiresAtMs: 0 },
      ROTATED_TOKEN_RETENTION_MS,
    );
  }

  private recordValidationRotation(
    redeemedToken: string,
    rotatedRefreshToken: string | undefined,
  ): void {
    if (rotatedRefreshToken && rotatedRefreshToken !== redeemedToken) {
      this.validationRotations.set(
        hashToken(redeemedToken),
        rotatedRefreshToken,
        VALIDATION_ROTATION_TTL_MS,
      );
    }
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

    // Prefer the most recently rotated refresh token; fall back to the stored
    // one only when we have never rotated in this process. If an in-memory
    // `latestRefreshToken` is itself rejected we intentionally do NOT retry with
    // the stored `refreshToken`: when an issuer rotates it invalidates the
    // predecessor, so the older stored token is necessarily already dead.
    // Surfacing the 401 (which prompts a reconnect) is correct rather than
    // masking it with a guaranteed-stale retry.
    const redeemedToken = latestRefreshToken ?? refreshToken;
    const { accessToken, expiresAtMs, rotatedRefreshToken } =
      await redeemWithXai(redeemedToken);

    const updatedDigests = appendKnownDigests(knownRefreshTokenDigests, [
      hashToken(refreshToken),
      rotatedRefreshToken && hashToken(rotatedRefreshToken),
    ]);
    this.tokenCache.set(
      providerApiKeyId,
      {
        accessToken,
        expiresAtMs,
        refreshBufferMs: refreshBufferFor(expiresAtMs - Date.now()),
        latestRefreshToken: rotatedRefreshToken ?? latestRefreshToken,
        knownRefreshTokenDigests: updatedDigests,
      },
      Math.max(expiresAtMs - Date.now(), 0) + ROTATED_TOKEN_RETENTION_MS,
    );

    if (rotatedRefreshToken && rotatedRefreshToken !== refreshToken) {
      this.queuePersist(providerApiKeyId, {
        newRefreshToken: rotatedRefreshToken,
        predecessorRefreshToken: redeemedToken,
        lineageDigests: updatedDigests,
      });
    }

    return accessToken;
  }

  /**
   * Resolves once every rotation persist queued so far for the key has
   * settled.
   *
   * @public — test hook: lets suites assert deterministically on the
   * fire-and-forget persist queue instead of sleeping.
   */
  async waitForPersistFlush(providerApiKeyId: string): Promise<void> {
    await this.persistQueues.get(providerApiKeyId);
  }

  private queuePersist(
    providerApiKeyId: string,
    params: PersistRotationParams,
  ) {
    const tail = this.persistQueues.get(providerApiKeyId) ?? Promise.resolve();
    const next = tail
      .then(() => this.persistRotatedRefreshToken(providerApiKeyId, params))
      .catch((error) => {
        logger.warn(
          { providerApiKeyId, error },
          "[XaiSubscription] failed to persist rotated refresh token",
        );
      });
    this.persistQueues.set(providerApiKeyId, next);
    // Fire-and-forget DB work: registered so shutdown/test teardown can drain
    // it instead of letting it race the database going away.
    trackBackgroundWork(next);
    next.finally(() => {
      if (this.persistQueues.get(providerApiKeyId) === next) {
        this.persistQueues.delete(providerApiKeyId);
      }
    });
  }

  private async persistRotatedRefreshToken(
    providerApiKeyId: string,
    params: PersistRotationParams,
  ): Promise<void> {
    const { newRefreshToken, predecessorRefreshToken, lineageDigests } = params;
    const keyRow = await LlmProviderApiKeyModel.findById(providerApiKeyId);
    if (!keyRow?.secretId) {
      return;
    }
    // Inspect the secret ROW's storage flags before resolving the value:
    // resolution dereferences BYOS Vault references, so a value-based
    // isVaultReference() check on the resolved credential never fires and
    // rotation would overwrite the stored reference with raw OAuth material.
    const secretRow = await SecretModel.findById(keyRow.secretId);
    if (!secretRow) {
      return;
    }
    if (secretRow.isByosVault) {
      logger.warn(
        { providerApiKeyId },
        "[XaiSubscription] skipping rotated refresh token persistence for vault-referenced key",
      );
      return;
    }
    const storedValue = await getSecretValueForLlmProviderApiKey(
      keyRow.secretId,
    );
    if (storedValue === undefined) {
      logger.warn(
        { providerApiKeyId },
        "[XaiSubscription] skipping rotated refresh token persistence: stored secret value is unreadable",
      );
      return;
    }
    const storedCredential = decodeXaiSubscriptionCredential(storedValue);
    if (!storedCredential) {
      // The stored secret is no longer a SuperGrok credential (e.g.
      // reconnected as a plain API key). Don't overwrite it.
      return;
    }
    if (storedCredential.refreshToken === newRefreshToken) {
      // Already persisted (another replica or an earlier queued write).
      return;
    }
    // Compare-and-swap: only overwrite a stored token this rotation descends
    // from. A reconnect — even to the SAME account — mints an independent token
    // family, and writing the old family's rotation over it would kill the
    // fresh sign-in.
    if (
      storedCredential.refreshToken !== predecessorRefreshToken &&
      !lineageDigests.includes(hashToken(storedCredential.refreshToken))
    ) {
      logger.warn(
        { providerApiKeyId },
        "[XaiSubscription] skipping rotated refresh token persistence: stored credential was replaced since this rotation",
      );
      return;
    }
    await secretManager().updateSecret(keyRow.secretId, {
      apiKey: encodeXaiSubscriptionCredential({
        ...storedCredential,
        refreshToken: newRefreshToken,
      }),
    });
  }
}

/** @public — exercised directly by unit tests (cache/single-flight/rotation) */
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
        refreshToken: credential.refreshToken,
        providerApiKeyId,
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
        xaiSubscriptionTokenManager.invalidate(providerApiKeyId, accessToken);
      }
      let freshAccessToken: string;
      try {
        freshAccessToken = await xaiSubscriptionTokenManager.getAccessToken({
          refreshToken: credential.refreshToken,
          providerApiKeyId,
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
  const { clientVersion } = config.llm.xai.subscription;
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

interface CachedAccessToken {
  accessToken: string;
  expiresAtMs: number;
  /** How early to redeem again, derived from this token's own lifetime. */
  refreshBufferMs: number;
  latestRefreshToken?: string;
  knownRefreshTokenDigests: string[];
}

interface InFlightRedemption {
  promise: Promise<string>;
  /** Digests of the credential lineage this flight redeems for — callers with a token outside it must not join. */
  lineageDigests: Set<string>;
}

interface PersistRotationParams {
  newRefreshToken: string;
  /** The exact token whose redemption produced `newRefreshToken`. */
  predecessorRefreshToken: string;
  /** Lineage digests known when the rotation happened, for the persist CAS. */
  lineageDigests: string[];
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
const ROTATED_TOKEN_RETENTION_MS = 24 * 60 * 60 * 1000;
const KNOWN_REFRESH_TOKEN_LIMIT = 8;
/** Fallback access-token lifetime when the response omits `expires_in`. */
const DEFAULT_ACCESS_TOKEN_TTL_MS = 60 * 60 * 1000;
/**
 * How long an ID-less validation rotation stays retrievable. Creation persists
 * it within the same request, so minutes of headroom is plenty.
 */
const VALIDATION_ROTATION_TTL_MS = 15 * 60 * 1000;

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

  const response = await fetch(tokenEndpoint, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: clientId,
    }),
    redirect: "manual",
  });

  if (!response.ok) {
    const body = await response.text();
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

  const payload = (await response.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
  };
  if (!payload.access_token) {
    throw new ApiError(
      502,
      "xAI token redemption returned an unexpected payload",
    );
  }

  return {
    accessToken: payload.access_token,
    expiresAtMs: accessTokenExpiryMs(payload.access_token, payload.expires_in),
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
