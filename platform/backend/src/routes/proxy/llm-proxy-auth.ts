/**
 * Authentication and API key resolution for the LLM proxy handler.
 *
 * Extracted from handleLLMProxy to keep the main handler focused on
 * request/response orchestration. Each function is independently testable.
 */

import type { FastifyRequest } from "fastify";
import { resolveProviderApiKey } from "@/clients/llm-client";
import logger from "@/logging";
import { AgentModel, VirtualApiKeyModel } from "@/models";
import {
  extractBearerToken,
  validateExternalIdpToken,
} from "@/routes/mcp-gateway.utils";
import { getSecretValueForLlmProviderApiKey } from "@/secrets-manager";
import { type Agent, ApiError, isSupportedChatProvider } from "@/types";

// =========================================================================
// Agent Resolution
// =========================================================================

/**
 * Resolve the target agent from the request URL or fall back to the default profile.
 */
export async function resolveAgent(
  agentId: string | undefined,
): Promise<Agent> {
  if (agentId) {
    const agent = await AgentModel.findById(agentId);
    if (!agent) {
      throw new ApiError(404, `Agent with ID ${agentId} not found`);
    }
    return agent;
  }

  const defaultProfile = await AgentModel.getDefaultProfile();
  if (!defaultProfile) {
    throw new ApiError(400, "Please specify an LLMProxy ID in the URL path.");
  }
  return defaultProfile;
}

// =========================================================================
// Virtual API Key Validation
// =========================================================================

export interface VirtualKeyValidationResult {
  apiKey: string | undefined;
  baseUrl: string | undefined;
}

/**
 * Validate an `archestra_` prefixed virtual API key.
 * Checks: token validity, expiration, provider match.
 * Returns the resolved real API key and optional base URL.
 *
 * Throws ApiError on validation failure.
 */
export async function validateVirtualApiKey(
  tokenValue: string,
  expectedProvider: string,
): Promise<VirtualKeyValidationResult> {
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

  if (resolved.chatApiKey.provider !== expectedProvider) {
    throw new ApiError(
      400,
      `Virtual API key is for provider "${resolved.chatApiKey.provider}", but request is for "${expectedProvider}"`,
    );
  }

  // Resolve the real provider API key from the secret
  let apiKey: string | undefined;
  if (resolved.chatApiKey.secretId) {
    const secretValue = await getSecretValueForLlmProviderApiKey(
      resolved.chatApiKey.secretId,
    );
    if (secretValue) {
      apiKey = secretValue as string;
    }
  }

  return {
    apiKey,
    baseUrl: resolved.chatApiKey.baseUrl ?? undefined,
  };
}

// =========================================================================
// JWKS Authentication
// =========================================================================

export interface JwksAuthResult {
  apiKey: string | undefined;
  baseUrl: string | undefined;
  userId: string | undefined;
  organizationId: string;
}

/**
 * Attempt JWKS authentication for agents with an external identity provider.
 * Returns null if no JWKS auth was attempted (no IdP configured, no bearer token, or virtual key token).
 * Throws ApiError if the JWT is invalid.
 */
export async function attemptJwksAuth(
  request: FastifyRequest,
  resolvedAgent: Agent,
  providerName: string,
): Promise<JwksAuthResult | null> {
  if (!resolvedAgent.identityProviderId) return null;

  const bearerToken = extractBearerToken(request);
  if (!bearerToken || bearerToken.startsWith("archestra_")) return null;

  const jwksResult = await validateExternalIdpToken(
    resolvedAgent.id,
    bearerToken,
    "llmProxy",
  );

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

  if (isSupportedChatProvider(providerName)) {
    const resolved = await resolveProviderApiKey({
      organizationId: jwksResult.organizationId,
      userId: jwksResult.userId,
      provider: providerName,
    });
    apiKey = resolved.apiKey;
    baseUrl = resolved.baseUrl ?? undefined;
  }

  return {
    apiKey,
    baseUrl,
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
export function assertAuthenticatedForKeylessProvider(
  apiKey: string | undefined,
  wasVirtualKeyResolved: boolean,
  wasJwksAuthenticated: boolean,
  requestIp: string,
): void {
  if (apiKey || wasVirtualKeyResolved || wasJwksAuthenticated) return;

  const isLocalhost =
    requestIp === "127.0.0.1" ||
    requestIp === "::1" ||
    requestIp === "::ffff:127.0.0.1";

  if (!isLocalhost) {
    throw new ApiError(
      401,
      "Authentication required. Use a virtual API key (archestra_...) or pass a provider API key.",
    );
  }
}
