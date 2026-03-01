import {
  DEFAULT_MODELS,
  FAST_MODELS,
  type SupportedProvider,
  SupportedProvidersSchema,
} from "@shared";
import { isVertexAiEnabled } from "@/clients/gemini-client";
import { resolveProviderApiKey } from "@/clients/llm-client";
import config, { getProviderEnvApiKey } from "@/config";
import logger from "@/logging";
import { ApiKeyModelModel, ChatApiKeyModel } from "@/models";

/**
 * Resolve the best available LLM provider, API key, model, and base URL
 * by iterating through configured providers and checking DB-managed keys.
 *
 * Resolution flow per provider:
 * 1. resolveProviderApiKey → if chatApiKeyId → getBestModel → return if found
 * 2. findSystemKey (e.g. Vertex AI with ADC) → getBestModel → return if found
 * 3. Next provider
 *
 * Returns null if no provider has both a key and a synced model in the DB.
 */
export async function resolveSmartDefaultLlm(params: {
  organizationId: string;
  userId?: string;
}): Promise<{
  provider: SupportedProvider;
  apiKey: string | undefined;
  modelName: string;
  baseUrl: string | null;
} | null> {
  const { organizationId, userId } = params;
  const providers = SupportedProvidersSchema.options;

  for (const provider of providers) {
    const { apiKey, chatApiKeyId, baseUrl } = await resolveProviderApiKey({
      organizationId,
      userId,
      provider,
    });

    if (chatApiKeyId) {
      const bestModel = await ApiKeyModelModel.getBestModel(chatApiKeyId);
      if (bestModel) {
        return { provider, apiKey, modelName: bestModel.modelId, baseUrl };
      }
    }

    // Fallback: check system keys (e.g., Vertex AI using ADC without an API key)
    const systemKey = await ChatApiKeyModel.findSystemKey(provider);
    if (systemKey) {
      const bestModel = await ApiKeyModelModel.getBestModel(systemKey.id);
      if (bestModel) {
        return {
          provider,
          apiKey,
          modelName: bestModel.modelId,
          baseUrl: systemKey.baseUrl,
        };
      }
    }
  }

  return null;
}

/**
 * Resolve the best LLM for chat with full fallback chain.
 * Extends `resolveSmartDefaultLlm` with chat-specific fallbacks:
 *
 * 1. DB-managed keys (via resolveSmartDefaultLlm)
 * 2. Environment variable API keys + hardcoded default models
 * 3. Vertex AI (Gemini without API key)
 * 4. Config defaults (ARCHESTRA_CHAT_DEFAULT_MODEL / ARCHESTRA_CHAT_DEFAULT_PROVIDER)
 *
 * Always returns a result — never null.
 */
export async function resolveSmartDefaultLlmForChat(params: {
  organizationId: string;
  userId: string;
}): Promise<{ model: string; provider: SupportedProvider }> {
  // 1. Try DB-managed keys first
  const dbResult = await resolveSmartDefaultLlm(params);
  if (dbResult) {
    return { model: dbResult.modelName, provider: dbResult.provider };
  }

  // 2. Check environment variable API keys as fallback
  for (const provider of SupportedProvidersSchema.options) {
    if (getProviderEnvApiKey(provider)) {
      return { model: DEFAULT_MODELS[provider], provider };
    }
  }

  // 3. Check if Vertex AI is enabled — use Gemini without API key
  if (isVertexAiEnabled()) {
    logger.info(
      { model: DEFAULT_MODELS.gemini },
      "resolveSmartDefaultLlmForChat: Vertex AI is enabled",
    );
    return { model: DEFAULT_MODELS.gemini, provider: "gemini" };
  }

  // 4. Ultimate fallback — use configured defaults
  return {
    model: config.chat.defaultModel,
    provider: config.chat.defaultProvider,
  };
}

/**
 * Resolve the fastest/cheapest model for a provider (used for title generation).
 * Tries the database lookup first, falls back to the hardcoded FAST_MODELS map.
 */
export async function resolveFastModelName(
  provider: SupportedProvider,
  chatApiKeyId: string | undefined,
): Promise<string> {
  if (!chatApiKeyId) {
    const fallback = FAST_MODELS[provider];
    logger.debug(
      { provider, modelName: fallback },
      "resolveFastModelName: no chatApiKeyId, using hardcoded fast model",
    );
    return fallback;
  }

  try {
    const fastestModel = await ApiKeyModelModel.getFastestModel(chatApiKeyId);
    if (fastestModel) {
      logger.debug(
        { provider, chatApiKeyId, modelId: fastestModel.modelId },
        "resolveFastModelName: resolved fastest model from DB",
      );
      return fastestModel.modelId;
    }
    logger.debug(
      { provider, chatApiKeyId },
      "resolveFastModelName: no fastest model in DB, using hardcoded fallback",
    );
  } catch (error) {
    logger.warn(
      { error, chatApiKeyId },
      "resolveFastModelName: failed to resolve from DB, falling back to hardcoded model",
    );
  }

  return FAST_MODELS[provider];
}
