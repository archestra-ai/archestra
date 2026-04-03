import {
  DEFAULT_MODELS,
  FAST_MODELS,
  type SupportedProvider,
  SupportedProvidersSchema,
} from "@shared";
import { isVertexAiEnabled } from "@/clients/gemini-client";
import { detectProviderFromModel } from "@/clients/llm-client";
import config, { getProviderEnvApiKey } from "@/config";
import logger from "@/logging";
import {
  LlmProviderApiKeyModel,
  LlmProviderApiKeyModelLinkModel,
  OrganizationModel,
} from "@/models";
import { getSecretValueForLlmProviderApiKey } from "@/secrets-manager";
import { resolveProviderApiKey } from "@/utils/llm-api-key-resolution";

export interface ConversationLlmSelection {
  chatApiKeyId: string | null;
  selectedModel: string;
  selectedProvider: SupportedProvider;
}

export interface ResolvedLlmSelection {
  provider: SupportedProvider;
  apiKey: string | undefined;
  modelName: string;
  baseUrl: string | null;
}

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
}): Promise<ResolvedLlmSelection | null> {
  const { organizationId, userId } = params;
  const providers = SupportedProvidersSchema.options;

  for (const provider of providers) {
    const { apiKey, chatApiKeyId, baseUrl } = await resolveProviderApiKey({
      organizationId,
      userId,
      provider,
    });

    if (chatApiKeyId) {
      const bestModel =
        await LlmProviderApiKeyModelLinkModel.getBestModel(chatApiKeyId);
      if (bestModel) {
        return { provider, apiKey, modelName: bestModel.modelId, baseUrl };
      }
    }

    // Fallback: check system keys (e.g., Vertex AI using ADC without an API key)
    const systemKey = await LlmProviderApiKeyModel.findSystemKey(provider);
    if (systemKey) {
      const bestModel = await LlmProviderApiKeyModelLinkModel.getBestModel(
        systemKey.id,
      );
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

export async function resolveConfiguredAgentLlm(agent: {
  llmApiKeyId: string | null;
  llmModel: string | null;
}): Promise<ResolvedLlmSelection | null> {
  if (agent.llmApiKeyId) {
    const apiKeyRecord = await LlmProviderApiKeyModel.findById(
      agent.llmApiKeyId,
    );
    if (!apiKeyRecord) {
      return null;
    }

    let apiKey: string | undefined;
    if (apiKeyRecord.secretId) {
      const secret = await getSecretValueForLlmProviderApiKey(
        apiKeyRecord.secretId,
      );
      apiKey = (secret as string) ?? undefined;
    }

    const modelName =
      agent.llmModel ??
      (await LlmProviderApiKeyModelLinkModel.getBestModel(apiKeyRecord.id))
        ?.modelId;
    if (!modelName) {
      return null;
    }

    return {
      provider: apiKeyRecord.provider,
      apiKey,
      modelName,
      baseUrl: apiKeyRecord.baseUrl,
    };
  }

  if (!agent.llmModel) {
    return null;
  }

  return {
    provider: detectProviderFromModel(agent.llmModel),
    apiKey: undefined,
    modelName: agent.llmModel,
    baseUrl: null,
  };
}

export async function resolveConversationLlmSelectionForAgent(params: {
  agent: {
    llmApiKeyId: string | null;
    llmModel: string | null;
  };
  organizationId: string;
  userId: string;
}): Promise<ConversationLlmSelection> {
  const { agent, organizationId, userId } = params;

  const agentSelection = await resolveAgentLlmSelection(agent);
  if (agentSelection) {
    return agentSelection;
  }

  const organizationSelection =
    await resolveOrganizationLlmSelection(organizationId);
  if (organizationSelection) {
    return organizationSelection;
  }

  const smartDefault = await resolveSmartDefaultLlmForChat({
    organizationId,
    userId,
  });

  return {
    chatApiKeyId: null,
    selectedModel: smartDefault.model,
    selectedProvider: smartDefault.provider,
  };
}

/**
 * Resolve the best LLM for chat with full fallback chain.
 * Extends `resolveSmartDefaultLlm` with chat-specific fallbacks:
 *
 * 1. DB-managed keys (via resolveSmartDefaultLlm)
 * 2. Organization-level default model (admin-configured)
 * 3. Environment variable API keys + hardcoded default models
 * 4. Vertex AI (Gemini without API key)
 * 5. Config defaults (ARCHESTRA_CHAT_DEFAULT_MODEL / ARCHESTRA_CHAT_DEFAULT_PROVIDER)
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

  // 2. Check organization-level default model
  const org = await OrganizationModel.getById(params.organizationId);
  if (org?.defaultLlmModel && org?.defaultLlmProvider) {
    return { model: org.defaultLlmModel, provider: org.defaultLlmProvider };
  }

  // 3. Check environment variable API keys as fallback
  for (const provider of SupportedProvidersSchema.options) {
    if (getProviderEnvApiKey(provider)) {
      return { model: DEFAULT_MODELS[provider], provider };
    }
  }

  // 4. Check if Vertex AI is enabled — use Gemini without API key
  if (isVertexAiEnabled()) {
    logger.info(
      { model: DEFAULT_MODELS.gemini },
      "resolveSmartDefaultLlmForChat: Vertex AI is enabled",
    );
    return { model: DEFAULT_MODELS.gemini, provider: "gemini" };
  }

  // 5. Ultimate fallback — use configured defaults
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
    const fastestModel =
      await LlmProviderApiKeyModelLinkModel.getFastestModel(chatApiKeyId);
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

async function resolveAgentLlmSelection(agent: {
  llmApiKeyId: string | null;
  llmModel: string | null;
}): Promise<ConversationLlmSelection | null> {
  if (agent.llmApiKeyId) {
    const apiKey = await LlmProviderApiKeyModel.findById(agent.llmApiKeyId);
    if (apiKey) {
      const provider = apiKey.provider;

      if (agent.llmModel) {
        return {
          chatApiKeyId: apiKey.id,
          selectedModel: agent.llmModel,
          selectedProvider: provider,
        };
      }

      const bestModel = await LlmProviderApiKeyModelLinkModel.getBestModel(
        apiKey.id,
      );
      if (bestModel) {
        return {
          chatApiKeyId: apiKey.id,
          selectedModel: bestModel.modelId,
          selectedProvider: provider,
        };
      }
    }
  }

  if (!agent.llmModel) {
    return null;
  }

  return {
    chatApiKeyId: null,
    selectedModel: agent.llmModel,
    selectedProvider: detectProviderFromModel(agent.llmModel),
  };
}

async function resolveOrganizationLlmSelection(
  organizationId: string,
): Promise<ConversationLlmSelection | null> {
  const organization = await OrganizationModel.getById(organizationId);
  if (!organization?.defaultLlmModel) {
    return null;
  }

  const apiKey = organization.defaultLlmApiKeyId
    ? await LlmProviderApiKeyModel.findById(organization.defaultLlmApiKeyId)
    : null;

  const selectedProvider =
    apiKey?.provider ??
    organization.defaultLlmProvider ??
    detectProviderFromModel(organization.defaultLlmModel);

  return {
    chatApiKeyId: apiKey?.id ?? null,
    selectedModel: organization.defaultLlmModel,
    selectedProvider,
  };
}
