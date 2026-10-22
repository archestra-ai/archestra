import { createHmac } from "node:crypto";
import {
  hasArchestraTokenPrefix,
  isSubscriptionCredential,
  type SupportedProvider,
} from "@archestra/shared";
import type { FastifyRequest } from "fastify";
import { serviceAccountUserId } from "@/auth/service-account-user-id";
import config from "@/config";
import {
  AgentTeamModel,
  LlmProviderApiKeyModel,
  MemberModel,
  UserTokenModel,
} from "@/models";
import { ResourcePermissions } from "@/services/resource-permissions";
import { assertSubscriptionCredentialForProvider } from "@/services/subscription-credential-guard";
import { ApiError, type GatewayAgent } from "@/types";
import { resolveProviderApiKey } from "@/utils/llm-api-key-resolution";
import {
  type ProviderKeySelection,
  selectMappedProviderKey,
} from "@/utils/provider-key-mappings";
import {
  assertConsistentUserCredentials,
  attemptJwksAuth,
  isJwtLike,
  resolveAgent,
  validateLlmOAuthAccessToken,
  validatePassthroughVirtualKey,
  validateVirtualApiKey,
  virtualKeyRateLimiter,
} from "./llm-proxy-auth";

export type ProxyResourcePrincipal = {
  kind: "user" | "service_account" | "virtual_key" | "oauth_client";
  id: string;
};

export type ProxyResourceCredential = {
  agent: GatewayAgent;
  principal: ProxyResourcePrincipal;
  /** Validated financial identities for the same common limit checks as inference. */
  limitContext: {
    userId?: string;
    virtualKeyId?: string;
    passthroughVirtualKeyId?: string;
    llmOauthClientId?: string;
    billingTeamId?: string;
  };
  providerAccount: {
    providerApiKeyId: string;
    baseUrl: string;
    credentialBinding: string;
  };
  apiKey?: string;
  defaultHeaders?: Record<string, string>;
  abortSignal?: AbortSignal;
};

/**
 * Resource APIs have no inference model. Reuse the proxy validators with strict
 * account selection instead of letting their ordinary model/default routing pick
 * an account. The returned binding is for a caller-owned resource ledger; it is
 * neither a provider credential nor an authorization grant on another request.
 */
export async function resolveProxyResourceCredential(params: {
  request: FastifyRequest;
  provider: SupportedProvider;
  agentId?: string;
  signal?: AbortSignal;
}): Promise<ProxyResourceCredential> {
  const { request, provider } = params;
  if (provider !== "azure" && provider !== "openai")
    throw new ApiError(
      400,
      "Provider resource APIs are supported only for OpenAI and Azure.",
    );
  const authorization = singleHeader(request, "authorization");
  const token = authorization?.match(/^Bearer\s+([^\s,]+)$/i)?.[1];
  const passthroughToken = singleHeader(request, "x-archestra-virtual-key");
  if (!token && !passthroughToken)
    throw new ApiError(401, "Resource requests require a platform credential.");
  const named = singleHeader(request, "provider-api-key-id");
  const chatNamed = singleHeader(request, "x-archestra-chat-api-key-id");
  if (named && chatNamed && named !== chatNamed)
    throw new ApiError(400, "Conflicting provider account selectors.");
  const selection: ProviderKeySelection = {
    requireUnique: true,
    providerApiKeyId: named ?? chatNamed,
  };
  const candidate = token ?? passthroughToken;
  await virtualKeyRateLimiter.check({ ip: request.ip, credential: candidate });
  try {
    const agent = await resolveAgent(params.agentId);
    const passthrough = passthroughToken
      ? await validatePassthroughVirtualKey({
          tokenValue: passthroughToken,
          agent,
        })
      : undefined;
    let principal: ProxyResourcePrincipal | undefined;
    const limitContext: ProxyResourceCredential["limitContext"] = {
      passthroughVirtualKeyId: passthrough?.passthroughVirtualKeyId,
      billingTeamId: passthrough?.billingTeamId,
    };
    let apiKey: string | undefined;
    let providerApiKeyId: string | undefined;
    const jwks = token
      ? await attemptJwksAuth(request, agent, provider, selection)
      : null;
    if (jwks) {
      if (!jwks.userId || jwks.organizationId !== agent.organizationId)
        throw new ApiError(
          403,
          "Resource principal does not belong to this organization.",
        );
      principal = { kind: "user", id: jwks.userId };
      apiKey = jwks.apiKey;
      providerApiKeyId = jwks.chatApiKeyId;
    } else if (token && hasArchestraTokenPrefix(token)) {
      const personal = await UserTokenModel.validateToken(token);
      if (personal) {
        if (personal.organizationId !== agent.organizationId)
          throw new ApiError(
            403,
            "Resource principal does not belong to this organization.",
          );
        await assertResourceUserAccess(personal.userId, agent);
        const resolved = await resolveProviderApiKey({
          organizationId: agent.organizationId,
          userId: personal.userId,
          provider,
          selection,
        });
        principal = { kind: "user", id: personal.userId };
        apiKey = resolved.apiKey;
        providerApiKeyId = resolved.chatApiKeyId;
      } else {
        const resolved = await validateVirtualApiKey({
          tokenValue: token,
          expectedProvider: provider,
          expectedOrganizationId: agent.organizationId,
          providerKeySelection: selection,
        });
        principal = resolved.serviceAccountId
          ? { kind: "service_account", id: resolved.serviceAccountId }
          : resolved.virtualKeyIsPersonal && resolved.virtualKeyAuthorId
            ? { kind: "user", id: resolved.virtualKeyAuthorId }
            : resolved.virtualKeyId
              ? { kind: "virtual_key", id: resolved.virtualKeyId }
              : undefined;
        apiKey = resolved.apiKey;
        providerApiKeyId = resolved.chatApiKeyId;
        limitContext.virtualKeyId = resolved.virtualKeyId;
        limitContext.billingTeamId ??= resolved.billingTeamId;
      }
    } else if (token) {
      const oauth = await validateLlmOAuthAccessToken({
        tokenValue: token,
        expectedProvider: provider,
        agent,
        providerKeySelection: selection,
      });
      if (oauth) {
        principal = oauth.serviceAccountId
          ? { kind: "service_account", id: oauth.serviceAccountId }
          : oauth.userId
            ? { kind: "user", id: oauth.userId }
            : oauth.authenticatedApp
              ? { kind: "oauth_client", id: oauth.authenticatedApp.id }
              : undefined;
        apiKey = oauth.apiKey;
        providerApiKeyId = oauth.chatApiKeyId;
        limitContext.llmOauthClientId = oauth.authenticatedApp?.id;
        limitContext.billingTeamId ??= oauth.billingTeamId;
      } else if (passthrough) {
        // A changing bearer token is not a stable provider-account identity.
        // Configured keyless rows are supported through managed credentials.
        if (isJwtLike(token))
          throw new ApiError(
            401,
            "File bearer authentication requires a configured provider account with a stable identity.",
          );
        const available = await LlmProviderApiKeyModel.getAvailableKeysForUser(
          agent.organizationId,
          passthrough.userId,
          [],
          provider,
        );
        const selected = await selectMappedProviderKey({
          mappings: available.map((key) => ({
            ...key,
            providerApiKeyId: key.id,
          })),
          provider,
          selection,
        });
        principal = { kind: "user", id: passthrough.userId };
        providerApiKeyId = selected?.id;
        apiKey = token;
      }
    }
    if (!principal || !providerApiKeyId)
      throw new ApiError(
        401,
        "Resource requests require a mapped platform credential and a configured provider account.",
      );
    if (principal.kind === "service_account" && passthrough?.userId)
      throw new ApiError(
        401,
        "Credentials identify both a user and a service account.",
      );
    limitContext.userId =
      principal.kind === "user" ? principal.id : passthrough?.userId;
    if (principal.kind === "user")
      await assertResourceUserAccess(principal.id, agent);
    if (
      principal.kind === "service_account" &&
      !(agent.agentType === "llm_proxy" && agent.isDefault)
    )
      await assertResourceAgentAccess(
        serviceAccountUserId(principal.id),
        agent,
      );
    assertConsistentUserCredentials([
      principal.kind === "user" ? principal.id : undefined,
      passthrough?.userId,
    ]);
    const row = await LlmProviderApiKeyModel.findById(providerApiKeyId);
    if (
      !row ||
      row.organizationId !== agent.organizationId ||
      row.provider !== provider ||
      row.requiresReauthentication
    )
      throw new ApiError(
        403,
        "The selected provider account is unavailable to this resource request.",
      );
    assertSubscriptionCredentialForProvider({ apiKey, provider });
    if (isSubscriptionCredential(apiKey))
      throw new ApiError(
        400,
        "Subscription credentials do not support provider resource APIs.",
      );
    if (!apiKey && !(provider === "azure" && config.llm.azure.entraIdEnabled))
      throw new ApiError(401, "The provider account has no usable credential.");
    const configuredBase =
      row.baseUrl ||
      (provider === "azure"
        ? config.llm.azure.baseUrl
        : provider === "openai"
          ? config.llm.openai.baseUrl || "https://api.openai.com/v1"
          : undefined);
    if (!configuredBase)
      throw new ApiError(
        400,
        "Resource requests require a configured provider resource endpoint.",
      );
    const url = new URL(configuredBase);
    if (
      !["https:", "http:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new ApiError(400, "Invalid provider resource endpoint.");
    if (provider === "azure")
      url.pathname = url.pathname.replace(/\/deployments\/[^/]+\/?$/, "");
    url.pathname = url.pathname.replace(/\/+$/, "");
    const baseUrl = url.toString().replace(/\/$/, "");
    const accountEndpoint =
      provider === "azure"
        ? baseUrl.replace(/\/openai\/v1$/, "/openai")
        : baseUrl;
    // Include the actual credential for raw passthrough, so two provider accounts
    // at the same URL can never share a file namespace. HMAC output is nonsecret.
    if (!config.auth.secret)
      throw new ApiError(
        503,
        "Resource binding is unavailable until the authentication secret is configured.",
      );
    const credentialBinding = createHmac("sha256", config.auth.secret)
      .update(
        JSON.stringify({
          version: 1,
          organizationId: agent.organizationId,
          principal,
          provider,
          providerApiKeyId,
          endpoint: accountEndpoint,
          headers: row.extraHeaders ?? {},
          credential: apiKey ?? "configured-workload-identity",
        }),
      )
      .digest("hex");
    await virtualKeyRateLimiter.recordSuccess({ credential: candidate });
    return {
      agent,
      principal,
      limitContext,
      providerAccount: { providerApiKeyId, baseUrl, credentialBinding },
      apiKey,
      defaultHeaders: row.extraHeaders ?? undefined,
      abortSignal: params.signal,
    };
  } catch (error) {
    if (error instanceof ApiError && error.statusCode === 401)
      await virtualKeyRateLimiter.recordFailure({
        ip: request.ip,
        credential: candidate,
      });
    throw error;
  }
}

async function assertResourceUserAccess(
  userId: string,
  agent: GatewayAgent,
): Promise<void> {
  if (!(await MemberModel.getByUserId(userId, agent.organizationId)))
    throw new ApiError(
      403,
      "Resource user is no longer a member of this organization.",
    );
  await assertResourceAgentAccess(userId, agent);
}

async function assertResourceAgentAccess(
  userId: string,
  agent: GatewayAgent,
): Promise<void> {
  const isAgentAdmin = await ResourcePermissions.allows({
    userId,
    organizationId: agent.organizationId,
    resource: "agent",
    scope: "*",
    action: "update",
  });
  if (
    !(await AgentTeamModel.userHasAgentAccess({
      userId,
      agentId: agent.id,
      isAgentAdmin,
      action: "use",
    }))
  )
    throw new ApiError(403, "Resource user cannot access this proxy.");
}

function singleHeader(
  request: FastifyRequest,
  name: string,
): string | undefined {
  const value = request.raw.headers[name];
  let count = 0;
  for (let index = 0; index < request.raw.rawHeaders.length; index += 2)
    if (request.raw.rawHeaders[index].toLowerCase() === name) count++;
  if (Array.isArray(value) || count > 1 || value?.includes(","))
    throw new ApiError(400, "Ambiguous resource authentication headers.");
  return value;
}
