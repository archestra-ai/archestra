import { createHmac, randomBytes } from "node:crypto";
import { ArchestraInternalErrorCode } from "@archestra/shared";
import { LRUCacheManager } from "@/cache-manager";
import config from "@/config";
import logger from "@/logging";
import LlmProviderApiKeyModel from "@/models/llm-provider-api-key";
import { withSubscriptionCredentialLock } from "@/models/subscription-credential-lock";
import { secretManager } from "@/secrets-manager";
import { ApiError } from "@/types";
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
const GROK_CLI_CLIENT_VERSION = "1.0.70";

const MAX_CACHED_TOKENS = 1000;

/** @public — independent instances exercise fleet-wide credential coordination in tests. */
export class XaiSubscriptionTokenManager {
  private tokenCache = new LRUCacheManager<CachedAccessToken>({
    maxSize: MAX_CACHED_TOKENS,
  });
  private validationRotations = new LRUCacheManager<XaiSubscriptionCredential>({
    maxSize: MAX_CACHED_TOKENS,
  });

  async getAccessToken(params: {
    credential: XaiSubscriptionCredential;
    providerApiKeyId?: string;
    staleAccessToken?: string;
  }): Promise<string> {
    const { credential, providerApiKeyId, staleAccessToken } = params;
    if (!providerApiKeyId) {
      const latest = this.latestKnownCredential(credential);
      if (
        freshCredentialAccessToken(credential) &&
        credential.accessToken !== staleAccessToken
      ) {
        return credential.accessToken;
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

    let rejectedCredential: XaiSubscriptionCredential | undefined;
    try {
      const result = await withSubscriptionCredentialLock({
        provider: "xai",
        providerApiKeyId,
        run: async (transaction) => {
          const row = await LlmProviderApiKeyModel.findById(
            providerApiKeyId,
            transaction,
          );
          const manager = secretManager(transaction);
          const secret =
            row?.provider === "xai" && row.secretId
              ? await manager.getSecret(row.secretId, { skipCache: true })
              : null;
          const stored = decodeXaiSubscriptionCredential(
            typeof secret?.secret?.apiKey === "string"
              ? secret.secret.apiKey
              : undefined,
          );
          if (!stored || !row?.secretId) {
            throw new ApiError(
              401,
              "SuperGrok credential is unreadable or has been replaced. Reconnect your Grok account.",
              ArchestraInternalErrorCode.ProviderAuthRequired,
            );
          }
          if (stored.userId !== credential.userId) {
            throw new ApiError(
              401,
              "SuperGrok account has changed. Reload the credential before retrying.",
              ArchestraInternalErrorCode.ProviderAuthRequired,
            );
          }
          if (
            freshCredentialAccessToken(stored) &&
            stored.accessToken !== staleAccessToken &&
            (stored.accessToken !== cached?.accessToken ||
              cached.expiresAtMs - cached.refreshBufferMs > Date.now())
          ) {
            return {
              credential: stored,
              digests: [hashToken(stored.refreshToken)],
            };
          }
          let redeemed: Awaited<ReturnType<typeof redeemWithXai>>;
          try {
            redeemed = await redeemWithXai(stored.refreshToken);
          } catch (error) {
            if (
              error instanceof ApiError &&
              error.internalCode ===
                ArchestraInternalErrorCode.ProviderAuthRequired
            ) {
              rejectedCredential = stored;
            }
            throw error;
          }
          const updated = {
            ...stored,
            refreshToken: redeemed.rotatedRefreshToken ?? stored.refreshToken,
            accessToken: redeemed.accessToken,
            accessTokenExpiresAtMs: redeemed.expiresAtMs,
          };
          const persisted = await manager.updateSecret(row.secretId, {
            apiKey: encodeXaiSubscriptionCredential(updated),
          });
          if (!persisted) {
            throw new ApiError(
              502,
              "Could not persist the refreshed SuperGrok credential",
            );
          }
          return {
            credential: updated,
            digests: [
              hashToken(stored.refreshToken),
              hashToken(updated.refreshToken),
            ],
          };
        },
      });
      const updated = result.credential;
      const expiresAtMs = updated.accessTokenExpiresAtMs as number;
      const accessToken = updated.accessToken as string;
      this.tokenCache.set(
        providerApiKeyId,
        {
          accessToken,
          expiresAtMs,
          refreshBufferMs: refreshBufferFor(expiresAtMs - Date.now()),
          userId: updated.userId,
          knownRefreshTokenDigests: appendKnownDigests(
            cached?.userId === updated.userId &&
              result.digests.some((digest) =>
                cached.knownRefreshTokenDigests.includes(digest),
              )
              ? cached.knownRefreshTokenDigests
              : [],
            result.digests,
          ),
        },
        Math.max(expiresAtMs - Date.now(), 0),
      );
      return accessToken;
    } catch (error) {
      if (rejectedCredential) {
        await this.recordAuthenticationFailure({
          providerApiKeyId,
          credential: rejectedCredential,
        });
      }
      throw error;
    }
  }

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
      if (
        providerApiKeyId &&
        error instanceof ApiError &&
        error.statusCode === 401
      ) {
        await xaiSubscriptionTokenManager.recordAuthenticationFailure({
          providerApiKeyId,
          credential,
        });
      }
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
        if (
          providerApiKeyId &&
          error instanceof ApiError &&
          error.statusCode === 401
        ) {
          await xaiSubscriptionTokenManager.recordAuthenticationFailure({
            providerApiKeyId,
            credential,
          });
        }
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

  const response = await fetch(tokenEndpoint, {
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

function freshCredentialAccessToken(
  credential: XaiSubscriptionCredential,
): credential is XaiSubscriptionCredential & {
  accessToken: string;
  accessTokenExpiresAtMs: number;
} {
  const remaining = (credential.accessTokenExpiresAtMs ?? 0) - Date.now();
  return Boolean(
    credential.accessToken && remaining - refreshBufferFor(remaining) > 0,
  );
}
