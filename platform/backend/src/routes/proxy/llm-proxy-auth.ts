/**
 * Authentication and API key resolution for the LLM proxy handler.
 *
 * Extracted from handleLLMProxy to keep the main handler focused on
 * request/response orchestration. Each function is independently testable.
 */

import { createHmac, randomBytes } from "node:crypto";
import {
  credentialRequiresPerUserScope,
  hasArchestraTokenPrefix,
  isSupportedProvider,
  LLM_PROXY_OAUTH_SCOPE,
  perUserCredentialLabel,
  type SupportedProvider,
} from "@archestra/shared";
import type { FastifyRequest } from "fastify";
import { archestraMcpBranding } from "@/archestra-mcp-server/branding";
import { userHasPermission } from "@/auth";
import { type AllowedCacheKey, CacheKey, cacheManager } from "@/cache-manager";
import config from "@/config";
import logger from "@/logging";
import {
  AgentModel,
  AgentTeamModel,
  LlmOauthClientModel,
  LlmProviderApiKeyModel,
  MemberModel,
  OAuthAccessTokenModel,
  OAuthClientModel,
  VirtualApiKeyModel,
} from "@/models";
import { reportVirtualKeyRateLimited } from "@/observability/metrics/proxy-auth";
import { validateExternalIdpToken } from "@/routes/mcp-gateway/utils";
import { getSecretValueForLlmProviderApiKey } from "@/secrets-manager";
import { isAppConnectorAudienceRef } from "@/services/apps/app-connector-resource";
import { assertSubscriptionCredentialForProvider } from "@/services/subscription-credential-guard";
import {
  ApiError,
  type GatewayAgent,
  type ResourceVisibilityScope,
} from "@/types";
import { resolveProviderApiKey } from "@/utils/llm-api-key-resolution";
import { isLoopbackRequest } from "@/utils/network";
import { getPassthroughVirtualKeyToken } from "./utils/headers/virtual-key";

// =========================================================================
// Agent Resolution
// =========================================================================

/**
 * The model named in an already-parsed request body, for the credential
 * resolution that runs before the handler builds its request adapter.
 *
 * Untrusted input read defensively: every provider this reaches puts the model
 * in a top-level `model` string, and anything else resolves as if unspecified.
 */
function requestedModelFromBody(request: FastifyRequest): string | null {
  const model = (request.body as { model?: unknown } | undefined)?.model;
  return typeof model === "string" && model.length > 0 ? model : null;
}

/**
 * Resolve the target agent from the request URL or fall back to the default profile.
 */
export async function resolveAgent(
  agentId: string | undefined,
): Promise<GatewayAgent> {
  if (agentId) {
    const agent = await AgentModel.findGatewayAgentById(agentId);
    if (!agent) {
      throw new ApiError(404, `Agent with ID ${agentId} not found`);
    }
    return agent;
  }

  const defaultProfile = await AgentModel.getDefaultGatewayProfile();
  if (!defaultProfile) {
    throw new ApiError(400, "Please specify an LLMProxy ID in the URL path.");
  }
  return defaultProfile;
}

// =========================================================================
// Virtual API Key Validation
// =========================================================================

export interface VirtualKeyValidationResult {
  apiKey?: string;
  baseUrl?: string;
  /** Parent chat_api_key row ID; used by the proxy to look up per-key settings (e.g. extra headers). */
  chatApiKeyId?: string;
  virtualKeyId?: string;
  /** Scope of the resolved key; a personal key identifies its owner. */
  virtualKeyScope?: ResourceVisibilityScope;
  /** Owner of the resolved key (for cross-credential user-consistency checks). */
  virtualKeyAuthorId?: string | null;
}

export interface PassthroughVirtualKeyResult {
  /** Owner of the passthrough key — the acting Archestra user. */
  userId: string;
  passthroughVirtualKeyId: string;
}

type ResolvedVirtualApiKey = NonNullable<
  Awaited<ReturnType<typeof VirtualApiKeyModel.validateToken>>
>;

export async function validateVirtualApiKeyToken(
  tokenValue: string,
): Promise<ResolvedVirtualApiKey> {
  const resolved = await VirtualApiKeyModel.validateToken(tokenValue);
  if (!resolved) {
    throw new ApiError(401, "Invalid virtual API key");
  }

  if (
    resolved.virtualKey.expiresAt &&
    resolved.virtualKey.expiresAt < new Date()
  ) {
    throw new ApiError(401, "Virtual API key expired");
  }

  return resolved;
}

/**
 * Validate a platform-managed virtual API key.
 * Checks: token validity, expiration, and provider mapping.
 * Returns the resolved real API key and optional base URL.
 *
 * Throws ApiError on validation failure.
 */
export async function validateVirtualApiKey(
  tokenValue: string,
  expectedProvider: string,
): Promise<VirtualKeyValidationResult> {
  const resolved = await validateVirtualApiKeyToken(tokenValue);
  if (resolved.virtualKey.keyType === "passthrough") {
    throw new ApiError(
      400,
      "Passthrough virtual keys carry no provider credential — send them in the X-Archestra-Virtual-Key header, not Authorization.",
    );
  }
  const mappedProviderKey = (
    await VirtualApiKeyModel.getProviderApiKeysForRouting(
      resolved.virtualKey.id,
    )
  ).find((mapping) => mapping.provider === expectedProvider);
  if (!mappedProviderKey) {
    throw new ApiError(
      400,
      `Virtual API key is not mapped to provider "${expectedProvider}".`,
    );
  }

  // Resolve the real provider API key from the secret first — the per-user
  // check below needs it to recognize a ChatGPT-subscription (Codex) credential.
  // If the parent key's secret was removed (orphaned row), apiKey will be
  // undefined. For providers that require keys, the upstream call will fail
  // with a clear error. For keyless providers the virtual key alone is
  // sufficient authentication.
  let apiKey: string | undefined;
  if (mappedProviderKey.secretId) {
    const secretValue = await getSecretValueForLlmProviderApiKey(
      mappedProviderKey.secretId,
    );
    if (secretValue) {
      apiKey = secretValue as string;
    } else {
      logger.warn(
        {
          virtualKeyId: resolved.virtualKey.id,
          chatApiKeyId: mappedProviderKey.providerApiKeyId,
          secretId: mappedProviderKey.secretId,
        },
        "Virtual key's parent chat API key secret could not be resolved (may be orphaned)",
      );
    }
  }

  // Some provider routes (for example Gemini query-key rewriting and Bedrock
  // model listing) consume this result directly instead of entering the
  // unified proxy handler. Guard here so no virtual-key sink can forward a
  // marker-owned refresh credential to the wrong provider or custom URL.
  if (isSupportedProvider(expectedProvider)) {
    assertSubscriptionCredentialForProvider({
      apiKey,
      provider: expectedProvider,
    });
  }

  // Per-user credentials — GitHub/Microsoft Copilot, and a ChatGPT-subscription
  // (Codex) key on `openai` — hold an individual's token, so it may only be
  // served through the owner's OWN personal virtual key mapping to their OWN
  // personal provider key. Re-checked here at runtime (not just at create/update)
  // so a virtual key mapped before this rule existed, or one whose scope/mapping
  // changed, can never hand the token to another user.
  if (
    isSupportedProvider(expectedProvider) &&
    credentialRequiresPerUserScope({ provider: expectedProvider, apiKey })
  ) {
    const parentKey = await LlmProviderApiKeyModel.findById(
      mappedProviderKey.providerApiKeyId,
    );
    if (
      resolved.virtualKey.scope !== "personal" ||
      !parentKey ||
      parentKey.scope !== "personal" ||
      parentKey.userId == null ||
      parentKey.userId !== resolved.virtualKey.authorId
    ) {
      throw new ApiError(
        403,
        `${perUserCredentialLabel({ provider: expectedProvider, apiKey })} is per-user: it can only be used through your own personal virtual key linked to your own account.`,
      );
    }
  }

  return {
    apiKey,
    baseUrl: mappedProviderKey.baseUrl ?? undefined,
    chatApiKeyId: mappedProviderKey.providerApiKeyId,
    virtualKeyId: resolved.virtualKey.id,
    virtualKeyScope: resolved.virtualKey.scope,
    virtualKeyAuthorId: resolved.virtualKey.authorId,
  };
}

// =========================================================================
// Passthrough Virtual Key Validation
// =========================================================================

/**
 * Validate a passthrough virtual key from the X-Archestra-Virtual-Key header.
 *
 * A passthrough key carries no provider credential. It authenticates the acting
 * Archestra user; access to the target LLM proxy is then governed by the owner's
 * own agent access (the same access any authenticated user would have).
 *
 * Throws ApiError on validation failure (401 invalid/expired, 400 wrong key
 * type, 403 no proxy access).
 */
export async function validatePassthroughVirtualKey(params: {
  tokenValue: string;
  agent: GatewayAgent;
}): Promise<PassthroughVirtualKeyResult> {
  const { tokenValue, agent } = params;

  const resolved = await VirtualApiKeyModel.validateToken(tokenValue);
  if (!resolved) {
    throw new ApiError(401, "Invalid passthrough virtual key");
  }
  const { virtualKey } = resolved;

  if (virtualKey.keyType !== "passthrough") {
    throw new ApiError(
      400,
      "This is a standard virtual key. Send it in the Authorization header instead of X-Archestra-Virtual-Key.",
    );
  }
  if (virtualKey.expiresAt && virtualKey.expiresAt < new Date()) {
    throw new ApiError(401, "Passthrough virtual key expired");
  }
  if (!virtualKey.authorId) {
    throw new ApiError(401, "Passthrough virtual key has no owner");
  }

  const noAccessError = new ApiError(
    403,
    "Your passthrough virtual key does not grant access to this LLM proxy. Contact your administrator.",
  );
  if (virtualKey.organizationId !== agent.organizationId) {
    throw noAccessError;
  }

  // Proxy access follows the owner's own agent access.
  const ownerIsAgentAdmin = await userHasPermission(
    virtualKey.authorId,
    agent.organizationId,
    "agent",
    "admin",
  );
  const hasProxyAccess = await AgentTeamModel.userHasAgentAccess(
    virtualKey.authorId,
    agent.id,
    ownerIsAgentAdmin,
  );
  if (!hasProxyAccess) {
    throw noAccessError;
  }

  return {
    userId: virtualKey.authorId,
    passthroughVirtualKeyId: virtualKey.id,
  };
}

/**
 * All authenticated user-scoped credentials on a request must resolve to a
 * single Archestra user. Throws 401 when two differ. Unauthenticated hints
 * (e.g. the X-Archestra-User-Id header) must NOT be passed in here.
 */
export function assertConsistentUserCredentials(
  userIds: Array<string | null | undefined>,
): void {
  const distinct = new Set(userIds.filter((id): id is string => Boolean(id)));
  if (distinct.size > 1) {
    throw new ApiError(
      401,
      `Conflicting ${archestraMcpBranding.appName} user credentials: the request's credentials identify different users.`,
    );
  }
}

// =========================================================================
// LLM OAuth Access Token Validation
// =========================================================================

export type LlmOAuthAccessTokenValidationResult = {
  apiKey: string | undefined;
  baseUrl: string | undefined;
  chatApiKeyId: string | undefined;
  authMethod: "oauth_client_credentials" | "oauth_user";
  authenticatedApp?: {
    id: string;
    name: string;
    clientId: string;
  };
  userId?: string;
};

export async function validateLlmOAuthAccessToken(params: {
  tokenValue: string;
  expectedProvider: string;
  agent: GatewayAgent;
  /**
   * Model named in the request body, when the caller has already parsed it.
   * Providers whose keys are servers (vLLM, Ollama, …) resolve the endpoint
   * that hosts this model rather than an arbitrary sibling.
   */
  requestedModel?: string | null;
}): Promise<LlmOAuthAccessTokenValidationResult | null> {
  const accessToken = await OAuthAccessTokenModel.getByTokenHash(
    OAuthAccessTokenModel.hashTokenForLookup(params.tokenValue),
  );
  if (!accessToken) {
    return null;
  }
  if (accessToken.expiresAt < new Date()) {
    throw new ApiError(401, "Invalid LLM OAuth access token.");
  }
  if (accessToken.refreshTokenRevoked) {
    throw new ApiError(401, "Invalid LLM OAuth access token.");
  }
  if (isAppConnectorAudienceRef(accessToken.referenceId)) {
    throw new ApiError(403, "Access token is bound to an app connector.");
  }
  if (!hasLlmProxyScope(accessToken.scopes)) {
    throw new ApiError(403, "Access token is missing LLM proxy scope.");
  }
  if (accessToken.userId) {
    return validateUserLlmOAuthAccessToken({
      userId: accessToken.userId,
      clientId: accessToken.clientId,
      expectedProvider: params.expectedProvider,
      agent: params.agent,
      requestedModel: params.requestedModel,
    });
  }

  return validateClientCredentialsLlmOAuthAccessToken({
    clientId: accessToken.clientId,
    expectedProvider: params.expectedProvider,
    agent: params.agent,
  });
}

// =========================================================================
// JWKS Authentication
// =========================================================================

export interface JwksAuthResult {
  apiKey: string | undefined;
  baseUrl: string | undefined;
  /** Resolved chat_api_key row ID; used by the proxy to look up per-key settings (e.g. extra headers). */
  chatApiKeyId: string | undefined;
  userId: string | undefined;
  organizationId: string;
}

/**
 * Attempt JWKS authentication for agents with an external identity provider.
 * Returns null if no JWKS auth was attempted (no IdP configured, no bearer token,
 * virtual key token, or the bearer value is not shaped like a JWT).
 * Throws ApiError if the JWT is invalid.
 */
export async function attemptJwksAuth(
  request: FastifyRequest,
  resolvedAgent: GatewayAgent,
  providerName: string,
): Promise<JwksAuthResult | null> {
  if (!resolvedAgent.identityProviderId) return null;

  // Read the bearer token from the RAW request headers. We cannot use
  // extractBearerToken(request) here because some provider routes (e.g.
  // OpenAI) define a headers schema with a .transform() that strips the
  // "Bearer " prefix. After Fastify applies the schema transform,
  // request.headers.authorization no longer starts with "Bearer ", causing
  // extractBearerToken to return null and silently skipping JWKS auth.
  // Reading from request.raw.headers bypasses schema transforms.
  const rawAuthHeader = request.raw.headers.authorization;
  const tokenMatch = rawAuthHeader?.match(/^Bearer\s+(.+)$/i);
  const bearerToken = tokenMatch?.[1] ?? null;
  if (!bearerToken || hasArchestraTokenPrefix(bearerToken)) return null;
  if (!isJwtLike(bearerToken)) return null;

  let jwksResult: Awaited<ReturnType<typeof validateExternalIdpToken>>;
  try {
    jwksResult = await validateExternalIdpToken(
      resolvedAgent.id,
      bearerToken,
      "llmProxy",
    );
  } catch (error) {
    // Convert any unexpected validation error to 401 (not 500)
    logger.warn(
      {
        resolvedAgentId: resolvedAgent.id,
        error: error instanceof Error ? error.message : String(error),
      },
      `[${providerName}Proxy] JWKS validation error`,
    );
    throw new ApiError(
      401,
      "JWT validation failed for the configured identity provider.",
    );
  }

  if (!jwksResult) {
    throw new ApiError(
      401,
      "Invalid JWT token for the configured identity provider.",
    );
  }

  logger.info(
    {
      resolvedAgentId: resolvedAgent.id,
      userId: jwksResult.userId,
      identityProviderId: resolvedAgent.identityProviderId,
    },
    `[${providerName}Proxy] JWKS authentication succeeded`,
  );

  let apiKey: string | undefined;
  let baseUrl: string | undefined;
  let chatApiKeyId: string | undefined;

  if (isSupportedProvider(providerName)) {
    const resolved = await resolveProviderApiKey({
      organizationId: jwksResult.organizationId,
      userId: jwksResult.userId,
      provider: providerName,
      modelName: requestedModelFromBody(request),
    });
    apiKey = resolved.apiKey;
    baseUrl = resolved.baseUrl ?? undefined;
    chatApiKeyId = resolved.chatApiKeyId;
  }

  return {
    apiKey,
    baseUrl,
    chatApiKeyId,
    userId: jwksResult.userId,
    organizationId: jwksResult.organizationId,
  };
}

// =========================================================================
// Keyless Provider Check
// =========================================================================

/**
 * For keyless providers (Ollama, vLLM, Vertex AI Gemini), ensure the request
 * was authenticated via a virtual API key or JWKS. Without this, anyone who
 * knows the proxy URL could call the endpoint without credentials.
 *
 * Internal requests from localhost (chat route → proxy) are allowed.
 */
export function assertAuthenticatedForKeylessProvider(params: {
  apiKey: string | undefined;
  wasVirtualKeyResolved: boolean;
  wasJwksAuthenticated: boolean;
  /**
   * Whether the request arrived over the loopback socket. Resolve it with
   * `isLoopbackRequest`, never from `request.ip`, which `trustProxy` rewrites
   * from forwarded headers.
   */
  isLoopbackCaller: boolean;
  /**
   * True when the backend authenticates upstream with its OWN credentials and
   * discards whatever the caller sent (Gemini in Vertex AI mode). A
   * caller-supplied Authorization value then proves nothing about who is
   * calling — it is never forwarded and never validated by anyone — so it must
   * not stand in for authentication. Defaults to false: for every other
   * provider the caller's key is forwarded upstream, which validates it.
   */
  providerSuppliesServerCredential?: boolean;
}): void {
  const {
    apiKey,
    wasVirtualKeyResolved,
    wasJwksAuthenticated,
    isLoopbackCaller,
    providerSuppliesServerCredential = false,
  } = params;

  if (wasVirtualKeyResolved || wasJwksAuthenticated) return;
  if (apiKey && !providerSuppliesServerCredential) return;

  if (!isLoopbackCaller) {
    throw new ApiError(
      401,
      providerSuppliesServerCredential
        ? "Authentication required. This provider is configured to use the server's own credentials, so requests must present a platform virtual API key or an identity provider token."
        : "Authentication required. Use a platform virtual API key or pass a provider API key.",
    );
  }
}

// =========================================================================
// Pass-through Proxy Authentication
// =========================================================================

/**
 * Authenticate a request that is forwarded straight upstream by a catch-all
 * pass-through proxy, where no adapter-based handler runs.
 *
 * Global session/RBAC auth stands down for `/v1/<provider>` paths because the
 * instrumented chat routes authenticate inside `handleLLMProxy`. The
 * pass-through routes registered alongside them never reach that handler, so
 * they authenticate here instead.
 *
 * Accepts the same platform credentials the instrumented handler does — a
 * passthrough virtual key, a standard virtual key, an external-IdP JWT, or an
 * LLM OAuth access token — and fails closed with 401 when none resolve. A raw
 * provider key is deliberately NOT accepted: these routes exist for providers
 * whose upstream needs no key, so any string would otherwise pass.
 */
export async function authenticatePassthroughProxyRequest(params: {
  request: FastifyRequest;
  provider: SupportedProvider;
  agentId?: string;
}): Promise<void> {
  const { request, provider, agentId } = params;

  // Internal loopback callers (in-app chat → proxy) are trusted, matching the
  // keyless-provider allowance in the instrumented handler.
  //
  // NOTE: this remains a broad allowance — traffic the frontend rewrites to the
  // API genuinely arrives over loopback, so it still lands here (#7229). Reading
  // the socket peer only removes the ability to *forge* that state through
  // forwarded headers; it does not narrow which callers qualify.
  if (isLoopbackRequest(request)) return;

  const unauthenticated = new ApiError(
    401,
    "Authentication required. Use a platform virtual API key, an LLM OAuth access token, or a configured identity provider token.",
  );

  const headers = request.headers as Record<
    string,
    string | string[] | undefined
  >;
  const passthroughToken = getPassthroughVirtualKeyToken(headers);
  // Read from the raw headers so a route-level schema transform cannot strip
  // the "Bearer " prefix out from under us (same reasoning as attemptJwksAuth).
  const bearerToken =
    request.raw.headers.authorization?.match(/^Bearer\s+(.+)$/i)?.[1] ?? null;

  if (!passthroughToken && !bearerToken) {
    throw unauthenticated;
  }

  const presentedCredential = passthroughToken ?? bearerToken ?? undefined;
  await virtualKeyRateLimiter.check({
    ip: request.ip,
    credential: presentedCredential,
  });
  const authenticate = async (): Promise<void> => {
    if (passthroughToken) {
      await validatePassthroughVirtualKey({
        tokenValue: passthroughToken,
        agent: await resolveAgent(agentId),
      });
      return;
    }
    if (!bearerToken) {
      throw unauthenticated;
    }

    if (hasArchestraTokenPrefix(bearerToken)) {
      // Token validity and expiry are the whole bar here. The provider-mapping
      // check that validateVirtualApiKey adds decides WHICH upstream credential
      // to use, and a pass-through forwards none — so requiring it would reject
      // otherwise-valid platform credentials for no security gain.
      await validateVirtualApiKeyToken(bearerToken);
      return;
    }

    const agent = await resolveAgent(agentId);
    if (await attemptJwksAuth(request, agent, provider)) return;
    if (
      await validateLlmOAuthAccessToken({
        tokenValue: bearerToken,
        expectedProvider: provider,
        agent,
        requestedModel: requestedModelFromBody(request),
      })
    ) {
      return;
    }
    throw unauthenticated;
  };

  try {
    await authenticate();
    await virtualKeyRateLimiter.recordSuccess({
      credential: presentedCredential,
    });
  } catch (error) {
    if (error instanceof ApiError && error.statusCode === 401) {
      await virtualKeyRateLimiter.recordFailure({
        ip: request.ip,
        credential: presentedCredential,
      });
    }
    throw error;
  }
}

// =========================================================================
// Virtual Key Rate Limiter
// =========================================================================

/**
 * Failures allowed per (IP, credential) pair, per window, before that pair is
 * rejected. Sized for a client retrying one credential, not for a shared origin.
 */
const RATE_LIMIT_MAX_FAILURES = config.llmProxy.authRateLimit.maxFailures;
/**
 * Failures allowed from one IP across ALL credentials, per window, before that
 * IP is rejected. This is the anti-enumeration backstop, so it must stay well
 * above the per-credential threshold: a single misconfigured client should
 * exhaust its own bucket long before it can exhaust its origin's.
 */
const RATE_LIMIT_MAX_FAILURES_PER_IP =
  config.llmProxy.authRateLimit.maxFailuresPerIp;
const RATE_LIMIT_WINDOW_MS = config.llmProxy.authRateLimit.windowMs;
/**
 * How long a credential stays exempt from the IP-wide backstop after it
 * validates. Short enough that a revoked credential loses the exemption
 * promptly, long enough to cover a client's ordinary request cadence.
 */
const RECENTLY_VALIDATED_TTL_MS = 5 * 60_000;

interface RateLimitEntry {
  count: number;
  /**
   * Epoch ms at which this fixed window ends, and with it the entry's TTL.
   *
   * Load-bearing: without it, every failure rewrote the entry with a full-length
   * TTL, so the counter only reset after a whole window with ZERO failures.
   * On a busy origin that silence never comes, and the count ratcheted upward
   * across minutes or hours until the bucket sat permanently over its ceiling —
   * a "10 per minute" limit rejecting a client that had failed 10 times all
   * day. Pinning the end of the window makes the documented rate the real one.
   *
   * Optional because entries written by an older build lack it. Those are read
   * as expired (a new window opens), which is the safe direction during a
   * rolling deploy: at worst one window's worth of failures is forgiven, and
   * never the reverse.
   */
  windowEndsAt?: number;
}

/**
 * Distributed rate limiter for failed virtual API key validation attempts.
 *
 * Counts failures in two buckets, both of which can reject a request:
 *
 *  - **(IP, credential)** at {@link RATE_LIMIT_MAX_FAILURES} — the bucket that
 *    does the day-to-day work. Scoping to the presented credential means one
 *    client hammering a revoked token cannot lock out a different client that
 *    holds a valid one, which is the failure mode a shared origin produces:
 *    behind a reverse proxy or LB (or, for requests the frontend rewrites to
 *    the API, behind loopback) many unrelated callers share a single `ip`.
 *  - **IP-wide** at {@link RATE_LIMIT_MAX_FAILURES_PER_IP} — retains the
 *    brute-force ceiling the per-credential bucket alone would give up, since
 *    an enumerator gets a fresh credential bucket for every token it guesses.
 *    A credential that validated in the last {@link RECENTLY_VALIDATED_TTL_MS}
 *    is exempt from this bucket (see {@link VirtualKeyRateLimiter.recordSuccess}):
 *    behind a shared origin the "IP" is the whole deployment, so without the
 *    exemption one scanner's guesses throttle every legitimate caller too. The
 *    exemption gives an attacker nothing — guessed credentials are by
 *    definition not ones that just validated.
 *
 * Both buckets are FIXED windows: the first failure fixes the window's end, and
 * later failures inside it neither extend it nor outlive it.
 *
 * The credential is reduced to a short salted-by-nothing SHA-256 fingerprint
 * rather than used verbatim: cache keys are persisted to PostgreSQL by the
 * shared CacheManager, and a bearer token (or any prefix long enough to
 * identify one) must not be written there in the clear.
 *
 * Uses the PostgreSQL-backed CacheManager (Keyv) so rate limit state is
 * shared across all application pods. Entries expire automatically via TTL.
 */
export class VirtualKeyRateLimiter {
  private cacheManager: {
    get: <T>(key: AllowedCacheKey) => Promise<T | undefined>;
    set: <T>(
      key: AllowedCacheKey,
      value: T,
      ttl?: number,
    ) => Promise<T | undefined>;
  };

  constructor(cacheManager: {
    get: <T>(key: AllowedCacheKey) => Promise<T | undefined>;
    set: <T>(
      key: AllowedCacheKey,
      value: T,
      ttl?: number,
    ) => Promise<T | undefined>;
  }) {
    this.cacheManager = cacheManager;
  }

  async check(params: { ip: string; credential?: string }): Promise<void> {
    const { ip, credential } = params;
    const now = Date.now();
    const [credentialEntry, ipEntry] = await Promise.all([
      this.cacheManager.get<RateLimitEntry>(this.credentialKey(ip, credential)),
      this.cacheManager.get<RateLimitEntry>(this.ipKey(ip)),
    ]);

    const credentialWindow = activeWindow(credentialEntry, now);
    if (credentialWindow.count >= RATE_LIMIT_MAX_FAILURES) {
      throw this.rejection({ ip, bucket: "credential", ...credentialWindow });
    }

    const ipWindow = activeWindow(ipEntry, now);
    if (
      ipWindow.count >= RATE_LIMIT_MAX_FAILURES_PER_IP &&
      !(await this.recentlyValidated(credential))
    ) {
      throw this.rejection({ ip, bucket: "ip", ...ipWindow });
    }
  }

  async recordFailure(params: {
    ip: string;
    credential?: string;
  }): Promise<void> {
    const { ip, credential } = params;
    await Promise.all([
      this.increment(this.credentialKey(ip, credential)),
      this.increment(this.ipKey(ip)),
    ]);
  }

  /**
   * Mark a credential as one that just authenticated, exempting it from the
   * IP-wide backstop while the mark lives. Called after a validation succeeds.
   *
   * Deliberately NOT scoped by IP: the point is to keep a working credential
   * working while its origin is noisy, and a client's requests can arrive from
   * several addresses (or through several pods) within one window.
   */
  async recordSuccess(params: { credential?: string }): Promise<void> {
    const { credential } = params;
    if (!credential) return;
    try {
      await this.cacheManager.set(
        this.validatedKey(credential),
        true,
        RECENTLY_VALIDATED_TTL_MS,
      );
    } catch (error) {
      // Best-effort: losing the mark only costs this credential its exemption
      // from a backstop that is not currently rejecting anything. Failing the
      // request over it would turn a cache blip into an outage.
      logger.debug(
        { err: error },
        "[LLMProxy] could not record a validated credential for the rate limiter",
      );
    }
  }

  private async increment(key: AllowedCacheKey): Promise<void> {
    const now = Date.now();
    const entry = await this.cacheManager.get<RateLimitEntry>(key);
    const window = activeWindow(entry, now);
    // Keep the existing window's end when one is open, so a burst of failures
    // cannot push the reset out indefinitely. The TTL tracks the window so the
    // entry disappears exactly when the count stops counting.
    const windowEndsAt = window.windowEndsAt ?? now + RATE_LIMIT_WINDOW_MS;
    await this.cacheManager.set<RateLimitEntry>(
      key,
      { count: window.count + 1, windowEndsAt },
      Math.max(windowEndsAt - now, 1),
    );
  }

  private async recentlyValidated(credential?: string): Promise<boolean> {
    if (!credential) return false;
    return (
      (await this.cacheManager.get<boolean>(this.validatedKey(credential))) ===
      true
    );
  }

  private rejection(params: {
    ip: string;
    bucket: "credential" | "ip";
    count: number;
    windowEndsAt?: number;
  }): ApiError {
    const { ip, bucket, count, windowEndsAt } = params;
    const retryAfterSeconds = windowEndsAt
      ? Math.max(Math.ceil((windowEndsAt - Date.now()) / 1000), 1)
      : Math.ceil(RATE_LIMIT_WINDOW_MS / 1000);

    // The rejection is otherwise indistinguishable from an upstream 429 the
    // proxy relays, which is what made "is this us or the provider?" guesswork.
    logger.warn(
      { ip, bucket, failures: count, retryAfterSeconds },
      "[LLMProxy] rejected a request: too many failed virtual API key attempts",
    );
    reportVirtualKeyRateLimited({ bucket });

    const error = new ApiError(
      429,
      `Too many failed virtual API key attempts. Please retry in ${retryAfterSeconds} seconds.`,
    );
    error.retryAfterSeconds = retryAfterSeconds;
    return error;
  }

  private credentialKey(ip: string, credential?: string): AllowedCacheKey {
    return `${CacheKey.VirtualKeyRateLimit}-${ip}-${fingerprintCredential(credential)}`;
  }

  private ipKey(ip: string): AllowedCacheKey {
    return `${CacheKey.VirtualKeyRateLimit}-ip-${ip}`;
  }

  private validatedKey(credential: string): AllowedCacheKey {
    return `${CacheKey.VirtualKeyRateLimit}-ok-${fingerprintCredential(credential)}`;
  }
}

export const virtualKeyRateLimiter = new VirtualKeyRateLimiter(cacheManager);

/**
 * The still-open window an entry describes, or an empty one when the entry is
 * absent, already past its end, or was written by a build that did not record
 * a window end.
 */
function activeWindow(
  entry: RateLimitEntry | undefined,
  now: number,
): { count: number; windowEndsAt?: number } {
  if (!entry || typeof entry.windowEndsAt !== "number") return { count: 0 };
  if (entry.windowEndsAt <= now) return { count: 0 };
  return { count: entry.count, windowEndsAt: entry.windowEndsAt };
}

async function validateClientCredentialsLlmOAuthAccessToken(params: {
  clientId: string;
  expectedProvider: string;
  agent: GatewayAgent;
}): Promise<LlmOAuthAccessTokenValidationResult> {
  const oauthClient = await LlmOauthClientModel.findByClientId(params.clientId);
  if (!oauthClient) {
    throw new ApiError(401, "LLM OAuth client is no longer available.");
  }
  if (oauthClient.disabled) {
    throw new ApiError(401, "LLM OAuth client is disabled.");
  }
  if (oauthClient.organizationId !== params.agent.organizationId) {
    throw new ApiError(403, "LLM OAuth client cannot access this LLM Proxy.");
  }
  if (!oauthClient.allowedLlmProxyIds.includes(params.agent.id)) {
    throw new ApiError(403, "LLM OAuth client cannot access this LLM Proxy.");
  }
  const mappedProviderKey = oauthClient.providerApiKeys.find(
    (mapping) => mapping.provider === params.expectedProvider,
  );
  if (!mappedProviderKey) {
    throw new ApiError(
      400,
      `LLM OAuth client is not mapped to provider "${params.expectedProvider}".`,
    );
  }

  const providerApiKey = await LlmProviderApiKeyModel.findById(
    mappedProviderKey.providerApiKeyId,
  );
  if (!providerApiKey) {
    throw new ApiError(
      500,
      "LLM OAuth client references a missing provider API key.",
    );
  }
  const oauthMappedSecret = providerApiKey.secretId
    ? ((await getSecretValueForLlmProviderApiKey(providerApiKey.secretId)) as
        | string
        | undefined)
    : undefined;

  // OAuth client credentials are a service-to-service credential with no acting
  // user. Per-user credentials — GitHub/Microsoft Copilot, and a
  // ChatGPT-subscription (Codex) key on `openai` — are an individual's token, so
  // they can never be served this way: there's no user to attribute, and the
  // mapped key would be one person's token for every caller.
  if (
    isSupportedProvider(params.expectedProvider) &&
    credentialRequiresPerUserScope({
      provider: params.expectedProvider,
      apiKey: oauthMappedSecret,
    })
  ) {
    throw new ApiError(
      400,
      `${perUserCredentialLabel({ provider: params.expectedProvider, apiKey: oauthMappedSecret })} is per-user and cannot be used via OAuth client credentials; each user must connect their own account.`,
    );
  }

  return resolveOAuthProviderApiKey({
    chatApiKeyId: providerApiKey.id,
    secretId: providerApiKey.secretId,
    baseUrl: providerApiKey.inferenceBaseUrl ?? providerApiKey.baseUrl,
    actualProvider: providerApiKey.provider,
    expectedProvider: params.expectedProvider,
    authMethod: "oauth_client_credentials",
    authenticatedApp: {
      id: oauthClient.id,
      name: oauthClient.name,
      clientId: oauthClient.clientId,
    },
  });
}

async function validateUserLlmOAuthAccessToken(params: {
  userId: string;
  clientId: string;
  expectedProvider: string;
  agent: GatewayAgent;
  requestedModel?: string | null;
}): Promise<LlmOAuthAccessTokenValidationResult> {
  const member = await MemberModel.getFirstMembershipForUser(params.userId);
  if (!member || member.organizationId !== params.agent.organizationId) {
    throw new ApiError(401, "OAuth user is no longer available.");
  }

  // Access has two additive sources: the user's own RBAC, or an admin-controlled
  // grant on the authorization_code LLM OAuth client that minted this token — its
  // allowedLlmProxyIds may grant access to proxies the user could not otherwise
  // reach (e.g. a proxy reachable only through a specific pre-registered app).
  const hasAgentAccess = await AgentTeamModel.userHasAgentAccess(
    params.userId,
    params.agent.id,
    false,
  );
  const hasClientGrant = hasAgentAccess
    ? false
    : await llmOauthClientGrantsProxyAccess({
        clientId: params.clientId,
        proxyId: params.agent.id,
        organizationId: member.organizationId,
      });
  if (!hasAgentAccess && !hasClientGrant) {
    throw new ApiError(403, "OAuth user cannot access this LLM Proxy.");
  }
  if (!isSupportedProvider(params.expectedProvider)) {
    throw new ApiError(
      400,
      `OAuth user access is not supported for provider "${params.expectedProvider}".`,
    );
  }

  const resolved = await resolveProviderApiKey({
    organizationId: member.organizationId,
    userId: params.userId,
    provider: params.expectedProvider,
    modelName: params.requestedModel,
  });
  const oauthClient = await OAuthClientModel.findByClientId(params.clientId);

  return {
    apiKey: resolved.apiKey,
    baseUrl: resolved.baseUrl ?? undefined,
    chatApiKeyId: resolved.chatApiKeyId,
    authMethod: "oauth_user",
    authenticatedApp: oauthClient
      ? {
          id: oauthClient.id,
          name: oauthClient.name ?? oauthClient.clientId,
          clientId: oauthClient.clientId,
        }
      : undefined,
    userId: params.userId,
  };
}

/**
 * Whether the authorization_code LLM OAuth client that minted a user-bound token
 * grants access to an LLM proxy beyond the user's own RBAC. Additive,
 * admin-controlled grant (see the MCP gateway equivalent). Disabled or deleted
 * clients grant nothing.
 */
async function llmOauthClientGrantsProxyAccess(params: {
  clientId: string;
  proxyId: string;
  organizationId: string;
}): Promise<boolean> {
  const oauthClient = await LlmOauthClientModel.findByClientId(params.clientId);
  if (!oauthClient || oauthClient.disabled) {
    return false;
  }
  if (oauthClient.grantType !== "authorization_code") {
    return false;
  }
  if (oauthClient.organizationId !== params.organizationId) {
    return false;
  }
  return oauthClient.allowedLlmProxyIds.includes(params.proxyId);
}

async function resolveOAuthProviderApiKey(params: {
  chatApiKeyId: string;
  secretId: string | null;
  baseUrl: string | null;
  actualProvider: string;
  expectedProvider: string;
  authMethod: "oauth_client_credentials" | "oauth_user";
  authenticatedApp?: {
    id: string;
    name: string;
    clientId: string;
  };
}): Promise<LlmOAuthAccessTokenValidationResult> {
  if (params.actualProvider !== params.expectedProvider) {
    throw new ApiError(
      400,
      `LLM OAuth client provider key is for provider "${params.actualProvider}", but request is for "${params.expectedProvider}"`,
    );
  }

  const apiKey = params.secretId
    ? await getSecretValueForLlmProviderApiKey(params.secretId)
    : undefined;
  return {
    apiKey,
    baseUrl: params.baseUrl ?? undefined,
    chatApiKeyId: params.chatApiKeyId,
    authMethod: params.authMethod,
    authenticatedApp: params.authenticatedApp,
  };
}

function hasLlmProxyScope(scopes: string[] | null | undefined): boolean {
  return scopes?.some((scope) => scope === LLM_PROXY_OAUTH_SCOPE) ?? false;
}

function isJwtLike(token: string): boolean {
  const parts = token.split(".");
  if (parts.length !== 3) return false;
  return parts.every((part) => /^[A-Za-z0-9_-]+$/.test(part));
}

/**
 * Domain-separated key for {@link fingerprintCredential}.
 *
 * Derived from the session-signing secret, so an existing deployment needs no
 * new configuration, and domain-separated so a rate-limit fingerprint can never
 * be mistaken for another HMAC that secret protects. The key must be identical
 * on every pod — limiter state is shared through PostgreSQL, so a per-process
 * key would give one credential a different bucket on each pod and multiply its
 * effective threshold by the replica count. A deployment with no auth secret
 * configured falls back to a per-process key and accepts that fragmentation.
 */
const CREDENTIAL_FINGERPRINT_KEY = config.auth.secret
  ? createHmac("sha256", config.auth.secret)
      .update("virtual-key-rate-limit-fingerprint")
      .digest()
  : randomBytes(32);

/**
 * Reduce a presented credential to a stable, non-reversible bucket id for the
 * rate limiter's cache key.
 *
 * Truncated to 32 bits: enough that unrelated callers on a shared origin get
 * their own bucket (the whole point of scoping by credential), short enough
 * that the key stays readable in the cache table. A collision merely puts two
 * credentials in one bucket — the same situation as before this scoping
 * existed — so collision resistance is not what this needs to buy.
 *
 * Keyed rather than a bare digest because these keys are persisted: an observer
 * of the cache table can neither read a token out of a bucket id nor confirm a
 * guessed one, which matters most for whatever low-entropy bearer tokens a
 * deployment's upstream may accept.
 *
 * Requests that present no credential at all share the "none" bucket.
 */
function fingerprintCredential(credential: string | undefined): string {
  if (!credential) return "none";
  const hmac = createHmac("sha256", CREDENTIAL_FINGERPRINT_KEY);
  // codeql[js/insufficient-password-hash] Buckets a bearer token for rate limiting, not password verification: the digest is never stored as a credential nor compared against one.
  return hmac.update(credential).digest("hex").slice(0, 8);
}
