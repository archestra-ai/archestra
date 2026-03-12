import type { EmbeddingModel, SupportedProvider } from "@shared";
import { DEFAULT_PROVIDER_BASE_URLS, getEmbeddingDimensions } from "@shared";
import OpenAI from "openai";
import { createDirectLLMModel, type LLMModel } from "@/clients/llm-client";
import logger from "@/logging";
import { ChatApiKeyModel, OrganizationModel } from "@/models";
import { getSecretValueForLlmProviderApiKey } from "@/secrets-manager";

interface EmbeddingConfig {
  client: OpenAI;
  model: EmbeddingModel;
  dimensions: number;
}

interface RerankerConfig {
  llmModel: LLMModel;
  modelName: string;
  provider: SupportedProvider;
}

/**
 * Resolve the embedding configuration for an organization.
 * Returns null if the organization doesn't have an embedding API key configured.
 */
export async function resolveEmbeddingConfig(
  organizationId: string,
): Promise<EmbeddingConfig | null> {
  const org = await OrganizationModel.getById(organizationId);
  if (!org?.embeddingChatApiKeyId || !org.embeddingModel) {
    return null;
  }

  const resolved = await resolveApiKeyFromChatApiKey(org.embeddingChatApiKeyId);
  if (!resolved) {
    logger.warn(
      { organizationId, chatApiKeyId: org.embeddingChatApiKeyId },
      "[KB] Embedding API key configured but secret could not be resolved",
    );
    return null;
  }

  return {
    client: new OpenAI({
      apiKey: resolved.apiKey,
      baseURL: resolved.baseUrl ?? undefined,
    }),
    model: org.embeddingModel,
    dimensions:
      org.embeddingDimensions ?? getEmbeddingDimensions(org.embeddingModel),
  };
}

/**
 * Resolve the reranker configuration for an organization.
 * Returns null if the organization doesn't have a reranker API key configured.
 */
export async function resolveRerankerConfig(
  organizationId: string,
): Promise<RerankerConfig | null> {
  const org = await OrganizationModel.getById(organizationId);
  if (!org?.rerankerChatApiKeyId || !org.rerankerModel) {
    return null;
  }

  const resolved = await resolveApiKeyFromChatApiKey(org.rerankerChatApiKeyId);
  if (!resolved) {
    logger.warn(
      { organizationId, chatApiKeyId: org.rerankerChatApiKeyId },
      "[KB] Reranker API key configured but secret could not be resolved",
    );
    return null;
  }

  const modelName = org.rerankerModel;

  return {
    llmModel: createDirectLLMModel({
      provider: resolved.provider,
      apiKey: resolved.apiKey,
      modelName,
      baseUrl: resolved.baseUrl,
    }),
    modelName,
    provider: resolved.provider,
  };
}

/**
 * Get the default organization and check if it has embedding configured.
 * Used by the embedding cron which runs without request context.
 */
export async function getDefaultOrgEmbeddingConfig(): Promise<{
  organizationId: string;
  config: EmbeddingConfig;
} | null> {
  const org = await OrganizationModel.getFirst();
  if (!org) return null;

  const embeddingConfig = await resolveEmbeddingConfig(org.id);
  if (!embeddingConfig) return null;

  return { organizationId: org.id, config: embeddingConfig };
}

/**
 * Resolve the actual API key, base URL, and provider from a chat API key ID.
 * Used by embedding config resolution and test-embedding endpoint.
 */
export async function resolveApiKeyFromChatApiKey(
  chatApiKeyId: string,
): Promise<{
  apiKey: string;
  baseUrl: string | null;
  provider: SupportedProvider;
} | null> {
  const chatApiKey = await ChatApiKeyModel.findById(chatApiKeyId);
  if (!chatApiKey) return null;

  // Fall back to the provider's default base URL when none is configured on the key
  const baseUrl =
    chatApiKey.baseUrl ||
    DEFAULT_PROVIDER_BASE_URLS[chatApiKey.provider] ||
    null;

  // Providers like Ollama don't require an API key — use a placeholder
  // since the OpenAI SDK requires a non-empty apiKey string
  if (!chatApiKey.secretId) {
    return {
      apiKey: "unused",
      baseUrl,
      provider: chatApiKey.provider,
    };
  }

  const apiKey = await getSecretValueForLlmProviderApiKey(chatApiKey.secretId);
  if (!apiKey) return null;

  return { apiKey, baseUrl, provider: chatApiKey.provider };
}
