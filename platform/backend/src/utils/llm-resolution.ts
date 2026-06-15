import {
  DEFAULT_MODELS,
  isCompleteModelSelection,
  type ModelSelection,
  providerRequiresPerUserCredential,
  resolveModelSelection,
  type SupportedProvider,
  SupportedProvidersSchema,
} from "@archestra/shared";
import { isVertexAiEnabled } from "@/clients/gemini-client";
import config, { getProviderEnvApiKey } from "@/config";
import logger from "@/logging";
import {
  LlmProviderApiKeyModel,
  LlmProviderApiKeyModelLinkModel,
  MemberModel,
  ModelModel,
  OrganizationModel,
  selectionKey,
  TeamModel,
} from "@/models";
import { getSecretValueForLlmProviderApiKey } from "@/secrets-manager";
import { resolveProviderApiKey } from "@/utils/llm-api-key-resolution";

/** A fully dereferenced selection ready for an LLM call. */
export interface ResolvedLlmSelection {
  provider: SupportedProvider;
  apiKey: string | undefined;
  modelName: string;
  baseUrl: string | null;
}

/**
 * The model resolved for a conversation.
 *
 * `modelId` is the models.id UUID to persist on the conversation; it is null
 * only when no model is configured anywhere and no provider has a synced
 * model (the env/Vertex/config fallback path). `selectedModel` /
 * `selectedProvider` are the dereferenced values for the LLM proxy.
 */
interface ConversationLlmSelection {
  modelId: string | null;
  chatApiKeyId: string | null;
  selectedModel: string;
  selectedProvider: SupportedProvider;
}

/**
 * Resolve the model for a conversation using the priority chain:
 *
 *   explicit pick -> member default -> agent default -> organization default
 *   -> best available model across the user's keys
 *
 * Each level is a foreign key, so a deleted model is simply NULL and the chain
 * falls through. When the database has no models at all, falls back to
 * environment / Vertex AI / config defaults (and `modelId` is null).
 */
export async function resolveConversationLlmSelectionForAgent(params: {
  agent: { llmApiKeyId: string | null; modelId: string | null };
  organizationId: string;
  userId: string;
  /** The model the user explicitly picked (highest priority). */
  explicitModelId?: string | null;
  /** The API key the user explicitly picked, alongside `explicitModelId`. */
  explicitApiKeyId?: string | null;
}): Promise<ConversationLlmSelection> {
  const { agent, organizationId, userId } = params;

  const member = await MemberModel.getByUserId(userId, organizationId);
  const organization = await OrganizationModel.getById(organizationId);

  const configuredLevels: ModelSelection[] = [
    { modelId: params.explicitModelId, apiKeyId: params.explicitApiKeyId },
    {
      modelId: member?.defaultModelId,
      apiKeyId: member?.defaultChatApiKeyId,
    },
    { modelId: agent.modelId, apiKeyId: agent.llmApiKeyId },
    {
      modelId: organization?.defaultModelId,
      apiKeyId: organization?.defaultLlmApiKeyId,
    },
  ];

  const [levels, availableModels] = await Promise.all([
    filterLinkedModelSelectionLevels(configuredLevels),
    getAvailableRankedModels({
      organizationId,
      userId,
    }),
  ]);

  const resolved = resolveModelSelection({ levels, availableModels });

  if (resolved?.modelId) {
    const model = await ModelModel.findById(resolved.modelId);
    if (model) {
      return {
        modelId: model.id,
        chatApiKeyId: resolved.apiKeyId ?? null,
        selectedModel: model.modelId,
        selectedProvider: model.provider,
      };
    }
  }

  // No synced model anywhere — fall back to env / Vertex / config defaults.
  const fallback = resolveDefaultLlmFromEnv();
  return {
    modelId: null,
    chatApiKeyId: null,
    selectedModel: fallback.model,
    selectedProvider: fallback.provider,
  };
}

/**
 * Dereference a conversation's stored `model_id` to the proxy-facing model
 * string and provider. Falls back to env / Vertex / config defaults when the
 * conversation has no model (e.g. created before any model was synced).
 */
export async function resolveConversationModel(
  modelId: string | null,
): Promise<{ model: string; provider: SupportedProvider }> {
  if (modelId) {
    const model = await ModelModel.findById(modelId);
    if (model) {
      return { model: model.modelId, provider: model.provider };
    }
  }
  return resolveDefaultLlmFromEnv();
}

/**
 * Resolve the best available LLM provider, API key, model, and base URL by
 * iterating configured providers and checking DB-managed keys.
 *
 * Returns null if no provider has both a key and a synced model.
 */
export async function resolveBestAvailableLlm(params: {
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
          baseUrl: systemKey.inferenceBaseUrl ?? systemKey.baseUrl,
        };
      }
    }
  }

  return null;
}

/**
 * Resolve an agent's explicitly configured LLM (its `modelId` FK and API key),
 * including the API key secret. Returns null when the agent has no usable
 * configuration.
 */
export async function resolveConfiguredAgentLlm(agent: {
  llmApiKeyId: string | null;
  modelId: string | null;
}): Promise<ResolvedLlmSelection | null> {
  if (agent.llmApiKeyId) {
    const apiKeyRecord = await LlmProviderApiKeyModel.findById(
      agent.llmApiKeyId,
    );
    if (!apiKeyRecord) {
      return null;
    }

    let apiKey: string | undefined;
    // For per-user providers (GitHub Copilot) the attached key is the agent
    // owner's personal token — never hand it to another user. Leave apiKey
    // undefined so resolveAgentLlmOrDefault falls through to per-user
    // resolution for the acting user.
    if (
      apiKeyRecord.secretId &&
      !providerRequiresPerUserCredential(apiKeyRecord.provider)
    ) {
      const secret = await getSecretValueForLlmProviderApiKey(
        apiKeyRecord.secretId,
      );
      apiKey = (secret as string) ?? undefined;
    }

    const model = agent.modelId
      ? await ModelModel.findById(agent.modelId)
      : null;
    const modelName =
      model?.modelId ??
      (await LlmProviderApiKeyModelLinkModel.getBestModel(apiKeyRecord.id))
        ?.modelId;
    if (!modelName) {
      return null;
    }

    return {
      provider: apiKeyRecord.provider,
      apiKey,
      modelName,
      baseUrl: apiKeyRecord.inferenceBaseUrl ?? apiKeyRecord.baseUrl,
    };
  }

  if (!agent.modelId) {
    return null;
  }
  const model = await ModelModel.findById(agent.modelId);
  if (!model) {
    return null;
  }
  return {
    provider: model.provider,
    apiKey: undefined,
    modelName: model.modelId,
    baseUrl: null,
  };
}

/**
 * Resolve an agent's configured LLM, filling in the provider API key when the
 * agent only pins a model. If the agent has no usable model selection, fall
 * back to organization/default resolution.
 */
export async function resolveAgentLlmOrDefault(params: {
  agent?: { llmApiKeyId: string | null; modelId: string | null } | null;
  organizationId: string;
  userId?: string;
  conversationId?: string;
}): Promise<ResolvedLlmSelection> {
  const configuredLlm = params.agent
    ? await resolveConfiguredAgentLlm(params.agent)
    : null;

  if (configuredLlm) {
    const fallbackKey = configuredLlm.apiKey
      ? null
      : await resolveProviderApiKey({
          organizationId: params.organizationId,
          userId: params.userId,
          provider: configuredLlm.provider,
          conversationId: params.conversationId,
          agentLlmApiKeyId: params.agent?.llmApiKeyId ?? null,
        });

    return {
      ...configuredLlm,
      apiKey: configuredLlm.apiKey ?? fallbackKey?.apiKey,
      baseUrl: configuredLlm.baseUrl ?? fallbackKey?.baseUrl ?? null,
    };
  }

  return resolveDefaultLlmSelection(params);
}

/**
 * Resolve the default LLM for built-in subagent operations:
 * organization default first, then best available DB-backed model, then the
 * env/Vertex/config fallback used during bootstrap.
 */
async function resolveDefaultLlmSelection(params: {
  organizationId: string;
  userId?: string;
}): Promise<ResolvedLlmSelection> {
  const organization = await OrganizationModel.getById(params.organizationId);

  if (organization?.defaultModelId && organization.defaultLlmApiKeyId) {
    const model = await ModelModel.findById(organization.defaultModelId);
    if (model) {
      const { apiKey, baseUrl } = await resolveProviderApiKey({
        organizationId: params.organizationId,
        userId: params.userId,
        provider: model.provider,
        agentLlmApiKeyId: organization.defaultLlmApiKeyId,
      });
      return {
        provider: model.provider,
        apiKey,
        modelName: model.modelId,
        baseUrl,
      };
    }
  }

  const bestAvailable = await resolveBestAvailableLlm(params);
  if (bestAvailable) {
    return bestAvailable;
  }

  const fallback = resolveDefaultLlmFromEnv();
  return {
    provider: fallback.provider,
    // Per-user providers must never use the shared env token (it would be one
    // account's token for everyone).
    apiKey: providerRequiresPerUserCredential(fallback.provider)
      ? undefined
      : getProviderEnvApiKey(fallback.provider),
    modelName: fallback.model,
    baseUrl: null,
  };
}

// ===== Internal helpers =====

/**
 * Ranked (model, key) pairs across every API key the user can access — the
 * "best available model" fallback for the resolution chain.
 */
async function getAvailableRankedModels(params: {
  organizationId: string;
  userId: string;
}) {
  const { organizationId, userId } = params;
  const userTeamIds = await TeamModel.getUserTeamIds(userId);
  const keys = await LlmProviderApiKeyModel.getAvailableKeysForUser(
    organizationId,
    userId,
    userTeamIds,
  );
  return LlmProviderApiKeyModelLinkModel.getRankedModelsForApiKeys(
    keys.map((key) => key.id),
  );
}

async function filterLinkedModelSelectionLevels(
  levels: ModelSelection[],
): Promise<ModelSelection[]> {
  const completeLevels = levels.filter(isCompleteModelSelection);
  const linkedSelectionKeys =
    await LlmProviderApiKeyModelLinkModel.getLinkedModelSelectionKeys(
      completeLevels,
    );

  return levels.map((level) => {
    if (!isCompleteModelSelection(level)) {
      return level;
    }

    if (linkedSelectionKeys.has(selectionKey(level))) {
      return level;
    }

    logger.info(
      { modelId: level.modelId, apiKeyId: level.apiKeyId },
      "Skipping configured LLM model selection because it is no longer linked to the API key",
    );
    return { modelId: null, apiKeyId: null };
  });
}

/**
 * Last-resort default when the database has no synced models: an environment
 * API key, then Vertex AI, then the configured chat default.
 */
function resolveDefaultLlmFromEnv(): {
  model: string;
  provider: SupportedProvider;
} {
  for (const provider of SupportedProvidersSchema.options) {
    // Skip per-user providers: their env token is shared and must not back a
    // system default (it would also resolve to no usable key downstream).
    if (
      getProviderEnvApiKey(provider) &&
      !providerRequiresPerUserCredential(provider)
    ) {
      return { model: DEFAULT_MODELS[provider], provider };
    }
  }

  if (isVertexAiEnabled()) {
    logger.info(
      { model: DEFAULT_MODELS.gemini },
      "resolveDefaultLlmFromEnv: Vertex AI is enabled",
    );
    return { model: DEFAULT_MODELS.gemini, provider: "gemini" };
  }

  return {
    model: config.chat.defaultModel,
    provider: config.chat.defaultProvider,
  };
}
