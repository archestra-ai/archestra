/**
 * Authentication and API key resolution for the LLM proxy handler.
 *
 * Extracted from handleLLMProxy to keep the main handler focused on
 * request/response orchestration. Each function is independently testable.
 */

import { createHmac, createSecretKey, randomBytes } from "node:crypto";
import {
  credentialRequiresPerUserScope,
  hasArchestraTokenPrefix,
  isSupportedProvider,
  LLM_PROXY_OAUTH_SCOPE,
  perUserCredentialLabel,
  type SupportedProvider,
  stripClaudeContextVariantSuffix,
} from "@archestra/shared";
import type { FastifyRequest } from "fastify";
import { archestraMcpBranding } from "@/archestra-mcp-server/branding";
import { serviceAccountUserId } from "@/auth/service-account-user-id";
import {
  type AllowedCacheKey,
  CacheKey,
  cacheManager,
  LRUCacheManager,
} from "@/cache-manager";
import { internalCallProvenance } from "@/clients/internal-call";
import config from "@/config";
import logger from "@/logging";
import {
  AgentModel,
  AgentTeamModel,
  ManagedOauthClientModel as LlmOauthClientModel,
  LlmProviderApiKeyModel,
  MemberModel,
  ModelPoolModel,
  OAuthAccessTokenModel,
  OAuthClientModel,
  OrganizationModel,
  type UserModel,
  UserTokenModel,
  VirtualApiKeyModel,
} from "@/models";
import { registerProcessLocalCache } from "@/process-local-cache-registry";
import { validateExternalIdpToken } from "@/routes/mcp-gateway/utils";
import { getSecretValueForLlmProviderApiKey } from "@/secrets-manager";
import { isAppConnectorAudienceRef } from "@/services/apps/app-connector-resource";
import { configCache } from "@/services/config-cache";
import { resolveOauthClientProviderMappings } from "@/services/oauth-client-providers";
import { resolveOauthServiceAccount } from "@/services/oauth-service-account";
import { ResourcePermissions } from "@/services/resource-permissions";
import { assertSubscriptionCredentialForProvider } from "@/services/subscription-credential-guard";
import { resolveVirtualKeyProviderMappings } from "@/services/virtual-key-providers";
import { ApiError, type GatewayAgent } from "@/types";
import { resolveProviderApiKey } from "@/utils/llm-api-key-resolution";
import {
  type ProviderKeySelection,
  selectMappedProviderKey,
} from "@/utils/provider-key-mappings";
import { type ModelPoolCaller, mayUseModelPool } from "./model-pool-failover";
import { getPassthroughVirtualKeyToken } from "./utils/headers/virtual-key";

export function isJwtLike(token: string): boolean {
  const parts = token.split(".");
  if (parts.length !== 3) return false;
  return parts.every((part) => /^[A-Za-z0-9_-]+$/.test(part));
}

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
 * Resolve the target agent for a proxy request.
 *
 * An id-less URL resolves to THE LLM Proxy. An id in the URL is a legacy
 * alias: an `llm_proxy` (or legacy `profile`) id collapses to its
 * organization's LLM Proxy, while any other agent id (in-app chat, app
 * runtime, delegation) resolves to that agent unchanged so its attribution
 * is preserved.
 */
export async function resolveAgent(
  agentId: string | undefined,
): Promise<GatewayAgent> {
  return configCache.read(`agent:${agentId ?? ""}`, () => readAgent(agentId));
}

// =========================================================================
// Virtual API Key Validation
// =========================================================================

export interface VirtualKeyValidationResult {
  serviceAccountId?: string;
  apiKey?: string;
  baseUrl?: string;
  /** Parent chat_api_key row ID; used by the proxy to look up per-key settings (e.g. extra headers). */
  chatApiKeyId?: string;
  virtualKeyId?: string;
  /** Whether the resolved key is its author's own; only such a key identifies its owner. */
  virtualKeyIsPersonal?: boolean;
  /** Owner of the resolved key (for cross-credential user-consistency checks). */
  virtualKeyAuthorId?: string | null;
  /** Team the key's spend is charged to, when it has one. */
  billingTeamId?: string;
  /**
   * The key maps no key of this provider and passed only because it may use
   * the pool the requested model names. No provider key is resolved.
   */
  modelPoolId?: string;
}

export interface PassthroughVirtualKeyResult {
  /** Owner of the passthrough key — the acting Archestra user. */
  userId: string;
  user: NonNullable<Awaited<ReturnType<typeof UserModel.getProxyIdentity>>>;
  passthroughVirtualKeyId: string;
  /** Team the key's spend is charged to, when it has one. */
  billingTeamId?: string;
  /** Fresh negative OAuth lookup for this exact request's provider token. */
  nonOAuthTokenHash?: string;
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
export async function validateVirtualApiKey(params: {
  tokenValue: string;
  expectedProvider: string;
  /**
   * Organization of the resolved proxy agent the request will be attributed
   * to, or null for pure credential-swap sinks with no agent attribution
   * (model listing, Gemini query-key rewriting). When set, a key from another
   * organization is rejected so its traffic can never be attributed — or
   * limit-checked — against a different organization's proxy.
   */
  expectedOrganizationId: string | null;
  /**
   * The model the request names, when it names one. A virtual key may map
   * several endpoints of a self-hosted provider; this picks the one that
   * serves the model. Without it the key's preferred endpoint answers.
   */
  requestedModel?: string | null;
  providerKeySelection?: ProviderKeySelection;
  /**
   * Set by callers that can serve a model pool. A key that maps no key of
   * this provider then still passes when it may use the pool the requested
   * model names.
   */
  allowModelPool?: boolean;
}): Promise<VirtualKeyValidationResult> {
  const { tokenValue, expectedProvider, expectedOrganizationId } = params;
  const resolved = await validateVirtualApiKeyToken(tokenValue);
  if (
    expectedOrganizationId !== null &&
    resolved.virtualKey.organizationId !== expectedOrganizationId
  ) {
    throw new ApiError(
      403,
      "Virtual API key does not belong to this organization.",
    );
  }
  if (resolved.virtualKey.createdByServiceAccountId)
    await resolveOauthServiceAccount({
      serviceAccountId: resolved.virtualKey.createdByServiceAccountId,
      organizationId: resolved.virtualKey.organizationId,
    });
  if (resolved.virtualKey.keyType === "passthrough") {
    throw new ApiError(
      400,
      "Passthrough virtual keys carry no provider credential — send them in the X-Archestra-Virtual-Key header, not Authorization.",
    );
  }
  const mappings = await resolveVirtualKeyProviderMappings(
    resolved.virtualKey.id,
  );
  const mappedProviderKey = isSupportedProvider(expectedProvider)
    ? await selectMappedProviderKey({
        mappings,
        provider: expectedProvider,
        modelId: params.requestedModel,
        selection: params.providerKeySelection,
      })
    : undefined;
  const modelPoolId =
    !mappedProviderKey && params.allowModelPool
      ? await usableModelPoolId({
          organizationId: resolved.virtualKey.organizationId,
          caller: {
            virtualKeyId: resolved.virtualKey.id,
            providerApiKeyIds: mappings.map(
              (mapping) => mapping.providerApiKeyId,
            ),
          },
          requestedModel: params.requestedModel,
        })
      : undefined;
  if (modelPoolId) {
    return {
      ...(await virtualKeyIdentity(resolved.virtualKey)),
      modelPoolId,
    };
  }
  if (!mappedProviderKey) {
    throw new ApiError(
      400,
      `Virtual API key is not mapped to provider "${expectedProvider}".`,
    );
  }
  if (
    mappedProviderKey.organizationId !== resolved.virtualKey.organizationId ||
    mappedProviderKey.providerApiKeyProvider !== expectedProvider
  )
    throw new ApiError(
      403,
      "Virtual API key references an unavailable provider account.",
    );

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
      !(await VirtualApiKeyModel.isPersonal(resolved.virtualKey)) ||
      !parentKey ||
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
    ...(await virtualKeyIdentity(resolved.virtualKey)),
  };
}

async function usableModelPoolId(params: {
  organizationId: string;
  caller: ModelPoolCaller;
  requestedModel?: string | null;
}): Promise<string | undefined> {
  if (!config.llmProxy.modelPoolsEnabled || !params.requestedModel)
    return undefined;
  const pool = await ModelPoolModel.findByName({
    organizationId: params.organizationId,
    name: stripClaudeContextVariantSuffix(params.requestedModel),
  });
  return pool && mayUseModelPool({ pool, caller: params.caller })
    ? pool.id
    : undefined;
}

async function virtualKeyIdentity(
  virtualKey: Awaited<
    ReturnType<typeof validateVirtualApiKeyToken>
  >["virtualKey"],
) {
  return {
    virtualKeyId: virtualKey.id,
    virtualKeyIsPersonal: await VirtualApiKeyModel.isPersonal(virtualKey),
    virtualKeyAuthorId: virtualKey.authorId,
    serviceAccountId: virtualKey.createdByServiceAccountId ?? undefined,
    billingTeamId: virtualKey.billingTeamId ?? undefined,
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
/**
 * Prefetch the gateway and credential rows; the caller must still rate-limit
 * and validate. The rows can come from the proxy configuration cache: the
 * token is still compared with its stored secret, and expiry and membership
 * are still checked, on every request.
 */
export async function readPassthroughAuthenticationSnapshot(params: {
  tokenValue: string;
  oauthTokenCandidate?: string;
}) {
  const oauthTokenHash = params.oauthTokenCandidate
    ? OAuthAccessTokenModel.hashTokenForLookup(params.oauthTokenCandidate)
    : undefined;
  return configCache.read(
    `credential:${VirtualApiKeyModel.tokenStartOf(params.tokenValue)}:${oauthTokenHash ?? ""}`,
    () =>
      VirtualApiKeyModel.readDeploymentProxyAndTokenOwner(
        params.tokenValue,
        oauthTokenHash,
      ),
  );
}

export async function validatePassthroughVirtualKey(params: {
  tokenValue: string;
  agent: GatewayAgent;
  oauthTokenCandidate?: string;
  authenticationSnapshot?: Awaited<
    ReturnType<typeof readPassthroughAuthenticationSnapshot>
  >;
}): Promise<PassthroughVirtualKeyResult> {
  const { tokenValue, agent } = params;

  const oauthTokenHash = params.oauthTokenCandidate
    ? OAuthAccessTokenModel.hashTokenForLookup(params.oauthTokenCandidate)
    : undefined;
  const resolved = await VirtualApiKeyModel.validateTokenWithOwner(
    tokenValue,
    oauthTokenHash,
    params.authenticationSnapshot?.agent.id === agent.id &&
      params.authenticationSnapshot.agent.organizationId ===
        agent.organizationId
      ? params.authenticationSnapshot
      : undefined,
  );
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

  const noAccessError = () =>
    new ApiError(
      403,
      "Your passthrough virtual key does not grant access to this LLM proxy. Contact your administrator.",
    );
  if (virtualKey.organizationId !== agent.organizationId) {
    throw noAccessError();
  }

  // The key acts as its owner, so the owner must still be a member of the
  // proxy's organization — keys are not purged on membership removal, and the
  // agent-access check below passes for any org-scoped agent regardless of
  // membership.
  const { user, membership } = resolved;
  if (!user || !membership) {
    throw noAccessError();
  }
  MemberModel.remember(membership);

  // The default organization proxy serves every current member and has no
  // scoped grant namespace. The fresh membership and organization checks above
  // already prove access; other agent kinds still need their scoped grants.
  if (agent.agentType !== "llm_proxy" || !agent.isDefault) {
    const ownerIsAgentAdmin = await ResourcePermissions.allows({
      userId: virtualKey.authorId,
      organizationId: agent.organizationId,
      resource: "agent",
      scope: "*",
      action: "update",
    });
    const hasProxyAccess = await AgentTeamModel.userHasAgentAccess({
      userId: virtualKey.authorId,
      agentId: agent.id,
      agentAccessContext: agent,
      isAgentAdmin: ownerIsAgentAdmin,
      action: "use",
    });
    if (!hasProxyAccess) {
      throw noAccessError();
    }
  }

  return {
    userId: virtualKey.authorId,
    user,
    passthroughVirtualKeyId: virtualKey.id,
    billingTeamId: virtualKey.billingTeamId ?? undefined,
    ...(resolved.oauthTokenAbsent && oauthTokenHash
      ? { nonOAuthTokenHash: oauthTokenHash }
      : {}),
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
  serviceAccountId?: string;
  /** Team a client-credentials client's spend is charged to, when it has one. */
  billingTeamId?: string;
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
  providerKeySelection?: ProviderKeySelection;
  /** A request-local negative lookup; never bypasses positive-token checks. */
  nonOAuthTokenHash?: string;
}): Promise<LlmOAuthAccessTokenValidationResult | null> {
  const tokenHash = OAuthAccessTokenModel.hashTokenForLookup(params.tokenValue);
  if (params.nonOAuthTokenHash === tokenHash) return null;
  const accessToken = await OAuthAccessTokenModel.getByTokenHash(tokenHash);
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
  const managedClient = await LlmOauthClientModel.findByClientId(
    accessToken.clientId,
  );
  if (managedClient?.disabled) {
    throw new ApiError(401, "LLM OAuth client is disabled.");
  }
  if (managedClient && !managedClient.scopes.includes(LLM_PROXY_OAUTH_SCOPE)) {
    throw new ApiError(403, "OAuth client no longer grants LLM proxy access.");
  }
  if (accessToken.userId) {
    return validateUserLlmOAuthAccessToken({
      userId: accessToken.userId,
      clientId: accessToken.clientId,
      expectedProvider: params.expectedProvider,
      agent: params.agent,
      requestedModel: params.requestedModel,
      providerKeySelection: params.providerKeySelection,
    });
  }

  return validateClientCredentialsLlmOAuthAccessToken({
    clientId: accessToken.clientId,
    expectedProvider: params.expectedProvider,
    agent: params.agent,
    requestedModel: params.requestedModel,
    providerKeySelection: params.providerKeySelection,
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
  providerKeySelection?: ProviderKeySelection,
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
      selection: providerKeySelection,
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
 * Ensure a proxy request carries a platform credential before anything reaches
 * the upstream.
 *
 * A standard virtual key, an LLM OAuth token, a personal platform token or an
 * identity provider JWT is enough on its own. A passthrough key authenticates
 * the user but carries no provider credential, so it counts only alongside a
 * provider key the caller sent: it must never unlock credentials the server
 * supplies (Vertex AI, Bedrock IAM, workload identity). A provider key alone is
 * rejected unless the organization enabled `allowUnauthenticatedLlmProxyRequests`.
 *
 * Internal calls (a valid in-process proof) are allowed. The organization
 * setting is read only when nothing else authenticates the request.
 */
export async function assertPlatformAuthenticated(params: {
  apiKey: string | undefined;
  /** A standard virtual key, LLM OAuth token or personal platform token resolved. */
  hasPlatformCredential: boolean;
  /** A passthrough virtual key from `X-Archestra-Virtual-Key` was validated. */
  wasPassthroughKeyValidated: boolean;
  wasJwksAuthenticated: boolean;
  /** The request carried a valid in-process proof (see `internalCallProvenance`). */
  isInternalCall: boolean;
  /**
   * True when the backend authenticates upstream with its OWN credentials and
   * discards whatever the caller sent (Gemini in Vertex AI mode). A
   * caller-supplied Authorization value then proves nothing about who is
   * calling — it is never forwarded and never validated by anyone — so it must
   * not stand in for authentication. Defaults to false: for every other
   * provider the caller's key is forwarded upstream, which validates it.
   */
  providerSuppliesServerCredential?: boolean;
  /** Reads the organization's `allowUnauthenticatedLlmProxyRequests` setting. */
  allowsUnauthenticated: () => Promise<boolean>;
}): Promise<void> {
  const {
    apiKey,
    hasPlatformCredential,
    wasPassthroughKeyValidated,
    wasJwksAuthenticated,
    isInternalCall,
    providerSuppliesServerCredential = false,
  } = params;

  if (hasPlatformCredential || wasJwksAuthenticated || isInternalCall) return;

  const callerSuppliesProviderKey =
    Boolean(apiKey) && !providerSuppliesServerCredential;
  if (wasPassthroughKeyValidated && callerSuppliesProviderKey) return;

  const allowUnauthenticated =
    callerSuppliesProviderKey && (await params.allowsUnauthenticated());
  if (allowUnauthenticated) return;

  throw new ApiError(
    401,
    providerSuppliesServerCredential
      ? "Authentication required. This provider is configured to use the server's own credentials, so requests must present a platform virtual API key or an identity provider token."
      : wasPassthroughKeyValidated
        ? "Authentication required. A passthrough key must be sent together with your provider API key."
        : "Authentication required. Send a virtual API key in the X-Archestra-Virtual-Key header or the Authorization header. A provider API key alone is not accepted.",
  );
}

// =========================================================================
// Pass-through Proxy Authentication
// =========================================================================

/**
 * The platform check a catch-all pass-through route runs before its upstream
 * sees the request.
 *
 * Credentials are checked first, so an authenticated request never reads the
 * organization setting. Only a request that fails with 401 falls back to
 * `allowUnauthenticatedLlmProxyRequests`, which restores anonymous forwarding.
 * If the agent in the URL cannot be resolved, the original 401 stands, so an
 * unauthenticated caller cannot probe which agent ids exist.
 */
export function createPassthroughAuthenticator(
  provider: SupportedProvider,
): (params: { request: FastifyRequest; agentId?: string }) => Promise<void> {
  return async ({ request, agentId }) => {
    try {
      await authenticatePassthroughProxyRequest({ request, provider, agentId });
    } catch (error) {
      if (!(error instanceof ApiError) || error.statusCode !== 401) throw error;
      if (!(await allowsUnauthenticatedForAgent(agentId))) throw error;
    }
  };
}

// =========================================================================
// Virtual Key Rate Limiter
// =========================================================================

/**
 * Failures allowed per (IP, credential) pair, per window, before that pair is
 * rejected. Sized for a client retrying one credential, not for a shared origin.
 */
const RATE_LIMIT_MAX_FAILURES = 10;
/**
 * Failures allowed from one IP across ALL credentials, per window, before that
 * IP is rejected. This is the anti-enumeration backstop, so it must stay well
 * above the per-credential threshold: a single misconfigured client should
 * exhaust its own bucket long before it can exhaust its origin's. Behind a
 * reverse proxy or ingress with `ARCHESTRA_TRUST_PROXY` unset, every external
 * request shares one `request.ip`, so this ceiling is deployment-wide — the
 * recently-validated exemption below is what keeps working credentials out of
 * its blast radius.
 */
const RATE_LIMIT_MAX_FAILURES_PER_IP = 100;
const RATE_LIMIT_WINDOW_MS = 60_000;
/**
 * How long a credential stays exempt from the IP-wide backstop after it
 * validates. Short enough that a revoked credential loses the exemption
 * promptly, long enough to cover a client's ordinary request cadence.
 */
const RECENTLY_VALIDATED_TTL_MS = 5 * 60_000;
// Coalesce bookkeeping only. A busy credential's exemption is refreshed at most
// once per second per process (up to one second less TTL).
const VALIDATION_MARK_REFRESH_MS = 1_000;
/**
 * How long this process skips the distributed bucket read for a credential it
 * just validated. Every request still validates its credential; only the
 * failure-count read is skipped, and any failure for the credential ends the
 * skip. Guessed credentials never validate, so they always read the buckets.
 */
const LOCAL_VALIDATION_TTL_MS = RATE_LIMIT_WINDOW_MS;

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
  private cache: RateLimitCache;
  private readonly successWrites = registerProcessLocalCache(
    new LRUCacheManager<Promise<void>>({
      maxSize: 10_000,
      defaultTtl: VALIDATION_MARK_REFRESH_MS,
    }),
  );

  /**
   * Credentials this process validated recently. A credential below its
   * failure limit when it validated cannot have reached the limit since
   * without failing here (which clears the mark) or failing elsewhere, and a
   * failure elsewhere only costs one more validation before this process
   * reads the buckets again. Validated credentials are exempt from the
   * IP-wide bucket, so neither bucket can reject them.
   */
  private readonly locallyValidated = registerProcessLocalCache(
    new LRUCacheManager<true>({
      maxSize: 10_000,
      defaultTtl: LOCAL_VALIDATION_TTL_MS,
    }),
  );

  constructor(cache: RateLimitCache) {
    this.cache = cache;
  }

  /** Rate-limit bookkeeping only; this never proves current authorization. */
  hasRecentValidation(credential: string): boolean {
    return this.locallyValidated.has(localKey(credential));
  }

  /**
   * Reads both buckets and the credential's validation mark in one statement,
   * unless this process validated the credential recently.
   */
  async check(params: { ip: string; credential?: string }): Promise<void> {
    const { ip, credential } = params;
    if (credential && this.hasRecentValidation(credential)) return;
    const now = Date.now();
    const credentialKey = this.credentialKey(ip, credential);
    const ipKey = this.ipKey(ip);
    const validatedKey = credential ? this.validatedKey(credential) : null;
    const entries = await this.cache.getMany<RateLimitEntry | boolean>(
      validatedKey
        ? [credentialKey, ipKey, validatedKey]
        : [credentialKey, ipKey],
    );

    const credentialWindow = activeWindow(
      asRateLimitEntry(entries.get(credentialKey)),
      now,
    );
    if (credentialWindow.count >= RATE_LIMIT_MAX_FAILURES) {
      throw this.rejection({ ip, bucket: "credential", ...credentialWindow });
    }

    const ipWindow = activeWindow(asRateLimitEntry(entries.get(ipKey)), now);
    if (
      ipWindow.count >= RATE_LIMIT_MAX_FAILURES_PER_IP &&
      !(validatedKey !== null && entries.get(validatedKey) === true)
    ) {
      throw this.rejection({ ip, bucket: "ip", ...ipWindow });
    }
  }

  /**
   * Counts a failure in both buckets with one atomic upsert, so concurrent
   * failures are never lost. An open window keeps its end, so a burst cannot
   * push the reset out; the entry expires when its window ends.
   */
  async recordFailure(params: {
    ip: string;
    credential?: string;
  }): Promise<void> {
    const { ip, credential } = params;
    if (credential) this.locallyValidated.delete(localKey(credential));
    await this.cache.incrementFixedWindows({
      keys: [this.credentialKey(ip, credential), this.ipKey(ip)],
      windowMs: RATE_LIMIT_WINDOW_MS,
    });
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
    this.locallyValidated.set(localKey(credential), true);
    const key = this.validatedKey(credential);
    const pending = this.successWrites.get(key);
    if (pending) return pending;
    const write = this.writeSuccess(key);
    this.successWrites.set(key, write);
    return write;
  }

  private async writeSuccess(key: AllowedCacheKey): Promise<void> {
    try {
      await this.cache.set(key, true, RECENTLY_VALIDATED_TTL_MS);
    } catch (error) {
      this.successWrites.delete(key);
      // Best-effort: losing the mark only costs this credential its exemption
      // from a backstop that is not currently rejecting anything. Failing the
      // request over it would turn a cache blip into an outage.
      logger.debug(
        { err: error },
        "[LLMProxy] could not record a validated credential for the rate limiter",
      );
    }
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

type RateLimitCache = Pick<
  typeof cacheManager,
  "getMany" | "incrementFixedWindows" | "set"
>;

function asRateLimitEntry(
  value: RateLimitEntry | boolean | undefined,
): RateLimitEntry | undefined {
  return typeof value === "object" ? value : undefined;
}

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
  requestedModel?: string | null;
  providerKeySelection?: ProviderKeySelection;
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
  const account = oauthClient.serviceAccountId
    ? await resolveOauthServiceAccount({
        serviceAccountId: oauthClient.serviceAccountId,
        organizationId: params.agent.organizationId,
      })
    : null;
  if (
    account &&
    !(params.agent.agentType === "llm_proxy" && params.agent.isDefault) &&
    !(await AgentTeamModel.userHasAgentAccess({
      userId: serviceAccountUserId(account.id),
      agentId: params.agent.id,
      agentAccessContext: params.agent,
      action: "use",
      isAgentAdmin: await ResourcePermissions.allows({
        userId: serviceAccountUserId(account.id),
        organizationId: params.agent.organizationId,
        resource: "agent",
        scope: "*",
        action: "update",
      }),
    }))
  )
    throw new ApiError(403, "Service account cannot access this LLM proxy.");
  const mappedProviderKey = isSupportedProvider(params.expectedProvider)
    ? await selectMappedProviderKey({
        mappings: await resolveOauthClientProviderMappings(oauthClient),
        provider: params.expectedProvider,
        modelId: params.requestedModel,
        selection: params.providerKeySelection,
      })
    : undefined;
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
  if (
    providerApiKey.organizationId !== oauthClient.organizationId ||
    providerApiKey.provider !== params.expectedProvider
  )
    throw new ApiError(
      403,
      "LLM OAuth client references an unavailable provider account.",
    );
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

  const resolvedKey = await resolveOAuthProviderApiKey({
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
  return {
    ...resolvedKey,
    billingTeamId: oauthClient.billingTeamId ?? undefined,
    serviceAccountId: account?.id,
  };
}

async function validateUserLlmOAuthAccessToken(params: {
  userId: string;
  clientId: string;
  expectedProvider: string;
  agent: GatewayAgent;
  requestedModel?: string | null;
  providerKeySelection?: ProviderKeySelection;
}): Promise<LlmOAuthAccessTokenValidationResult> {
  const member = await MemberModel.getByUserId(
    params.userId,
    params.agent.organizationId,
  );
  if (!member) {
    throw new ApiError(401, "OAuth user is no longer available.");
  }

  const hasAgentAccess = await AgentTeamModel.userHasAgentAccess({
    userId: params.userId,
    agentId: params.agent.id,
    agentAccessContext: params.agent,
    isAgentAdmin: false,
    action: "use",
  });
  if (!hasAgentAccess) {
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
    selection: params.providerKeySelection,
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
const CREDENTIAL_FINGERPRINT_KEY = createSecretKey(
  config.auth.secret
    ? createHmac("sha256", config.auth.secret)
        .update("virtual-key-rate-limit-fingerprint")
        .digest()
    : randomBytes(32),
);

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
/** Full-length digest: a process-local key must never collide with a guess. */
function localKey(credential: string): string {
  return createHmac("sha256", CREDENTIAL_FINGERPRINT_KEY)
    .update(credential)
    .digest("base64url");
}

function fingerprintCredential(credential: string | undefined): string {
  if (!credential) return "none";
  const hmac = createHmac("sha256", CREDENTIAL_FINGERPRINT_KEY);
  // codeql[js/insufficient-password-hash] Buckets a bearer token for rate limiting, not password verification: the digest is never stored as a credential nor compared against one.
  return hmac.update(credential).digest("hex").slice(0, 8);
}

/**
 * Whether the organization behind `agentId` allows LLM proxy requests without
 * a platform credential. An agent that cannot be resolved reads as false, so
 * the caller keeps the original 401 instead of learning the agent is missing.
 */
async function allowsUnauthenticatedForAgent(
  agentId: string | undefined,
): Promise<boolean> {
  let organizationId: string;
  try {
    organizationId = (await resolveAgent(agentId)).organizationId;
  } catch {
    return false;
  }
  return OrganizationModel.allowsUnauthenticatedLlmProxyRequests(
    organizationId,
  );
}

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
 * passthrough virtual key, a standard virtual key, a personal platform token,
 * an external-IdP JWT, or an LLM OAuth access token — and fails closed with 401
 * when none resolve. A raw provider key is deliberately NOT accepted: some of
 * these upstreams need no key, so any string would otherwise pass.
 */
async function authenticatePassthroughProxyRequest(params: {
  request: FastifyRequest;
  provider: SupportedProvider;
  agentId?: string;
}): Promise<void> {
  const { request, provider, agentId } = params;

  // In-process callers that carry the internal proof are trusted, matching the
  // keyless-provider allowance in the instrumented handler. The proof is a
  // per-process secret, so a request arriving through the frontend rewrite
  // cannot satisfy it. Taking it also keeps it off the forwarded request.
  const proof = internalCallProvenance(request);
  if (proof.inProcess || proof.guardrail) return;

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
  let authenticatedBearer = false;
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
      // A personal platform token shares the prefix. The instrumented handler
      // accepts it, so the catch-all does too: it names a member of the proxy's
      // organization.
      const personalToken = await UserTokenModel.validateToken(bearerToken);
      if (personalToken) {
        const agent = await resolveAgent(agentId);
        const member =
          personalToken.organizationId === agent.organizationId &&
          (await MemberModel.getByUserId(
            personalToken.userId,
            agent.organizationId,
          ));
        if (!member) throw unauthenticated;
        authenticatedBearer = true;
        return;
      }
      // Token validity and expiry are the whole bar here. The provider-mapping
      // check that validateVirtualApiKey adds decides WHICH upstream credential
      // to use, and a pass-through forwards none — so requiring it would reject
      // otherwise-valid platform credentials for no security gain.
      await validateVirtualApiKeyToken(bearerToken);
      authenticatedBearer = true;
      return;
    }

    const agent = await resolveAgent(agentId);
    if (await attemptJwksAuth(request, agent, provider)) {
      authenticatedBearer = true;
      return;
    }
    if (
      await validateLlmOAuthAccessToken({
        tokenValue: bearerToken,
        expectedProvider: provider,
        agent,
        requestedModel: requestedModelFromBody(request),
      })
    ) {
      authenticatedBearer = true;
      return;
    }
    throw unauthenticated;
  };

  try {
    await authenticate();
    if (authenticatedBearer && bearerToken) {
      stripAuthenticatedBearer(request, bearerToken);
    }
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

/**
 * A bearer accepted by the platform is not an upstream credential. Match the
 * validated value rather than a token prefix: IdP/OAuth tokens have other
 * formats, and a downstream Archestra may legitimately use an arch_ key.
 * Keep distinct caller-supplied provider credentials intact.
 */
function stripAuthenticatedBearer(request: FastifyRequest, token: string) {
  const headerNames = new Set([
    "authorization",
    "x-api-key",
    "api-key",
    "x-goog-api-key",
  ]);
  const stripValue = (value: string): string | undefined => {
    // Node joins repeated credential headers with commas. Remove matching
    // credentials from that list without discarding a separate provider key.
    const values = value.split(",");
    const retained = values.filter((entry) => {
      const credential = entry.trim();
      return (
        credential !== token &&
        credential.match(/^Bearer\s+(.+)$/i)?.[1] !== token
      );
    });
    if (retained.length === values.length) return value;
    return retained.length
      ? retained.map((entry) => entry.trim()).join(", ")
      : undefined;
  };
  for (const headers of new Set([request.headers, request.raw.headers])) {
    for (const name of headerNames) {
      const value = headers[name];
      if (value === undefined) continue;
      const retained = (Array.isArray(value) ? value : [value])
        .map(stripValue)
        .filter((entry) => entry !== undefined);
      if (retained.length === 0) delete headers[name];
      else headers[name] = Array.isArray(value) ? retained : retained[0];
    }
  }
  const rawHeaders = request.raw.rawHeaders;
  if (rawHeaders) {
    for (let i = rawHeaders.length - 2; i >= 0; i -= 2) {
      if (!headerNames.has(rawHeaders[i].toLowerCase())) continue;
      const retained = stripValue(rawHeaders[i + 1]);
      if (retained === undefined) rawHeaders.splice(i, 2);
      else rawHeaders[i + 1] = retained;
    }
  }
  const url = request.raw.url;
  if (url?.includes("?")) {
    const queryStart = url.indexOf("?");
    const segments = url.slice(queryStart + 1).split("&");
    const retained = segments.filter(
      (segment) => !new URLSearchParams(segment).getAll("key").includes(token),
    );
    if (retained.length !== segments.length) {
      // Preserve the other parameters byte for byte, including literal question
      // marks, escaping and order. Re-serializing can change signed provider URLs.
      request.raw.url =
        url.slice(0, queryStart) +
        (retained.length ? `?${retained.join("&")}` : "");
    }
  }
}

async function readAgent(agentId: string | undefined): Promise<GatewayAgent> {
  if (agentId) {
    const agent = await AgentModel.findGatewayAgentById(agentId);
    if (!agent) {
      throw new ApiError(404, `Agent with ID ${agentId} not found`);
    }
    if (agent.agentType === "llm_proxy" || agent.agentType === "profile") {
      if (agent.agentType === "llm_proxy" && agent.isDefault) {
        return agent;
      }
      return AgentModel.getOrgLlmProxy(agent.organizationId);
    }
    return agent;
  }

  const llmProxy = await AgentModel.getDeploymentLlmProxy();
  if (!llmProxy) {
    throw new ApiError(503, "No organization exists yet.");
  }
  return llmProxy;
}
