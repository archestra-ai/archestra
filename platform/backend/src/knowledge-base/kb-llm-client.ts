import type { EmbeddingModel, SupportedProvider } from "@shared";
import { getEmbeddingDimensions } from "@shared";
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

  const model = org.embeddingModel as EmbeddingModel;
  return {
    client: new OpenAI({
      apiKey: resolved.apiKey,
      baseURL: resolved.baseUrl ?? undefined,
    }),
    model,
    dimensions: getEmbeddingDimensions(model),
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

// ===== Internal helpers =====

async function resolveApiKeyFromChatApiKey(chatApiKeyId: string): Promise<{
  apiKey: string;
  baseUrl: string | null;
  provider: SupportedProvider;
} | null> {
  const chatApiKey = await ChatApiKeyModel.findById(chatApiKeyId);
  if (!chatApiKey?.secretId) return null;

  const apiKey = await getSecretValueForLlmProviderApiKey(chatApiKey.secretId);
  if (!apiKey) return null;

  return { apiKey, baseUrl: chatApiKey.baseUrl, provider: chatApiKey.provider };
}
