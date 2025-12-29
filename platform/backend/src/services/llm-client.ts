import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { EXTERNAL_AGENT_ID_HEADER, USER_ID_HEADER } from "@shared";
import config from "@/config";
import logger from "@/logging";
import { ChatApiKeyModel, TeamModel } from "@/models";
import { isVertexAiEnabled } from "@/routes/proxy/utils/gemini-client";
import { secretManager } from "@/secretsmanager";
import { ApiError, type SupportedChatProvider } from "@/types";

export type LLMClient =
  | ReturnType<typeof createAnthropic>
  | ReturnType<typeof createGoogleGenerativeAI>
  | ReturnType<typeof createOpenAI>;

/**
 * Detect which provider a model belongs to based on its name
 */
export function detectProviderFromModel(model: string): SupportedChatProvider {
  const lowerModel = model.toLowerCase();

  if (lowerModel.includes("claude")) {
    return "anthropic";
  }

  if (lowerModel.includes("gemini") || lowerModel.includes("google")) {
    return "gemini";
  }

  if (
    lowerModel.includes("gpt") ||
    lowerModel.includes("o1") ||
    lowerModel.includes("o3")
  ) {
    return "openai";
  }

  // Default to anthropic for backwards compatibility
  return "anthropic";
}

/**
 * Resolve API key for a provider using priority:
 * conversation > personal > team > org_wide > environment variable
 */
export async function resolveProviderApiKey(params: {
  organizationId: string;
  userId: string;
  provider: SupportedChatProvider;
  conversationId?: string | null;
}): Promise<{ apiKey: string | undefined; source: string }> {
  const { organizationId, userId, provider, conversationId } = params;

  let providerApiKey: string | undefined;
  let apiKeySource = "environment";

  // Get user's team IDs for API key resolution
  const userTeamIds = await TeamModel.getUserTeamIds(userId);

  // Try scope-based resolution (checks conversation's chatApiKeyId first, then personal > team > org_wide)
  const resolvedApiKey = await ChatApiKeyModel.getCurrentApiKey({
    organizationId,
    userId,
    userTeamIds,
    provider,
    conversationId: conversationId ?? null,
  });

  if (resolvedApiKey?.secretId) {
    const secret = await secretManager().getSecret(resolvedApiKey.secretId);
    // Support both old format (anthropicApiKey) and new format (apiKey)
    const secretValue =
      secret?.secret?.apiKey ??
      secret?.secret?.anthropicApiKey ??
      secret?.secret?.geminiApiKey ??
      secret?.secret?.openaiApiKey;
    if (secretValue) {
      providerApiKey = secretValue as string;
      apiKeySource = resolvedApiKey.scope;
    }
  }

  // Fall back to environment variable
  if (!providerApiKey) {
    if (provider === "anthropic" && config.chat.anthropic.apiKey) {
      providerApiKey = config.chat.anthropic.apiKey;
      apiKeySource = "environment";
    } else if (provider === "openai" && config.chat.openai.apiKey) {
      providerApiKey = config.chat.openai.apiKey;
      apiKeySource = "environment";
    } else if (provider === "gemini" && config.chat.gemini.apiKey) {
      providerApiKey = config.chat.gemini.apiKey;
      apiKeySource = "environment";
    }
  }

  return { apiKey: providerApiKey, source: apiKeySource };
}

/**
 * Check if API key is required for the given provider
 */
export function isApiKeyRequired(
  provider: SupportedChatProvider,
  apiKey: string | undefined,
): boolean {
  // For Gemini with Vertex AI enabled, API key is not required
  const isGeminiWithVertexAi = provider === "gemini" && isVertexAiEnabled();
  return !apiKey && !isGeminiWithVertexAi;
}

/**
 * Create an LLM client for the specified provider, pointing to the LLM Proxy
 */
export function createLLMClient(params: {
  provider: SupportedChatProvider;
  apiKey: string | undefined;
  agentId: string;
  userId?: string;
  externalAgentId?: string;
}): LLMClient {
  const { provider, apiKey, agentId, userId, externalAgentId } = params;

  // Build headers for LLM Proxy
  const clientHeaders: Record<string, string> = {};
  if (externalAgentId) {
    clientHeaders[EXTERNAL_AGENT_ID_HEADER] = externalAgentId;
  }
  if (userId) {
    clientHeaders[USER_ID_HEADER] = userId;
  }

  const headers =
    Object.keys(clientHeaders).length > 0 ? clientHeaders : undefined;

  if (provider === "anthropic") {
    // URL format: /v1/anthropic/:agentId/v1/messages
    return createAnthropic({
      apiKey,
      baseURL: `http://localhost:${config.api.port}/v1/anthropic/${agentId}/v1`,
      headers,
    });
  }

  if (provider === "gemini") {
    // URL format: /v1/gemini/:agentId/v1beta/models
    // For Vertex AI mode, pass a placeholder - the LLM Proxy uses ADC for auth
    return createGoogleGenerativeAI({
      apiKey: apiKey || "vertex-ai-mode",
      baseURL: `http://localhost:${config.api.port}/v1/gemini/${agentId}/v1beta`,
      headers,
    });
  }

  if (provider === "openai") {
    // URL format: /v1/openai/:agentId (SDK appends /chat/completions)
    return createOpenAI({
      apiKey,
      baseURL: `http://localhost:${config.api.port}/v1/openai/${agentId}`,
      headers,
    });
  }

  throw new Error(`Unsupported provider: ${provider}`);
}

/**
 * Full helper to resolve API key and create LLM client
 */
export async function createLLMClientForAgent(params: {
  organizationId: string;
  userId: string;
  agentId: string;
  model: string;
  conversationId?: string | null;
  externalAgentId?: string;
}): Promise<{
  client: LLMClient;
  provider: SupportedChatProvider;
  apiKeySource: string;
}> {
  const {
    organizationId,
    userId,
    agentId,
    model,
    conversationId,
    externalAgentId,
  } = params;

  const provider = detectProviderFromModel(model);

  const { apiKey, source } = await resolveProviderApiKey({
    organizationId,
    userId,
    provider,
    conversationId,
  });

  // Check if Gemini with Vertex AI (doesn't require API key)
  const isGeminiWithVertexAi = provider === "gemini" && isVertexAiEnabled();

  logger.info(
    { apiKeySource: source, provider, isGeminiWithVertexAi },
    "Using LLM provider API key",
  );

  if (!apiKey && !isGeminiWithVertexAi) {
    throw new ApiError(
      400,
      "LLM Provider API key not configured. Please configure it in Chat Settings.",
    );
  }

  const client = createLLMClient({
    provider,
    apiKey,
    agentId,
    userId,
    externalAgentId,
  });

  return { client, provider, apiKeySource: source };
}
