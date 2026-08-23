import {
  DEFAULT_MODELS,
  isCompleteModelSelection,
  isSubscriptionCredential,
  type ModelInputModality,
  type ModelSelection,
  providerHasEndpointLocalModels,
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
  /**
   * The chat_api_keys row that supplied `apiKey`, when it came from a stored
   * key. Callers that run the selection through the LLM proxy loopback must
   * forward it (createLLMModel's `chatApiKeyId`) so per-key state binds to the
   * right row — critically, ChatGPT-subscription (Codex) refresh tokens rotate
   * on every redemption, and without the row id the proxy redeems bare and
   * DISCARDS the rotated token, permanently burning the stored credential.
   */
  chatApiKeyId?: string;
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
 *
 * The member-default level is the model/key the user last picked in the /chat
 * model selector — a personal preference for that UI. It should NOT bleed into
 * runs the user isn't actively driving there (chatops replies, scheduled
 * triggers, external A2A), where the surprising outcome is a Slack bot or a cron
 * job silently using whatever model someone last chose in web chat. Those
 * callers pass `includeMemberChatDefault: false` so resolution reflects the
 * agent's own configuration (then org default, then best-available) — which is
 * both predictable and self-explanatory to the user.
 */
export async function resolveConversationLlmSelectionForAgent(params: {
  agent: { llmApiKeyId: string | null; modelId: string | null };
  organizationId: string;
  userId: string;
  /** The model the user explicitly picked (highest priority). */
  explicitModelId?: string | null;
  /** The API key the user explicitly picked, alongside `explicitModelId`. */
  explicitApiKeyId?: string | null;
  /**
   * Whether the acting member's /chat default (defaultModelId /
   * defaultChatApiKeyId) participates in resolution. Defaults to true (the
   * /chat surfaces). Non-/chat A2A callers pass false. See the doc comment.
   */
  includeMemberChatDefault?: boolean;
}): Promise<ConversationLlmSelection> {
  const { agent, organizationId, userId } = params;
  const includeMemberChatDefault = params.includeMemberChatDefault ?? true;

  // A per-user provider model (e.g. GitHub Copilot) is catalogued org-wide and
  // its credential is resolved per-user at request time, so an explicit pick is
  // honored by model alone: the key is not pinned and need not be linked to the
  // picked key (which, for a member who hasn't connected, is some other
  // provider's key the picker carried over). The acting user's own credential is
  // resolved when the message is sent — or a connect prompt is surfaced if they
  // haven't linked one.
  if (params.explicitModelId) {
    const explicitModel = await ModelModel.findById(params.explicitModelId);
    if (
      explicitModel &&
      providerRequiresPerUserCredential(explicitModel.provider)
    ) {
      return {
        modelId: explicitModel.id,
        chatApiKeyId: null,
        selectedModel: explicitModel.modelId,
        selectedProvider: explicitModel.provider,
      };
    }
  }

  const [member, organization] = await Promise.all([
    MemberModel.getByUserId(userId, organizationId),
    OrganizationModel.getById(organizationId),
  ]);

  const configuredLevels: ModelSelection[] = [
    { modelId: params.explicitModelId, apiKeyId: params.explicitApiKeyId },
    ...(includeMemberChatDefault
      ? [
          {
            modelId: member?.defaultModelId,
            apiKeyId: member?.defaultChatApiKeyId,
          },
        ]
      : []),
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
        // A per-user provider model never pins a key: the resolved key (e.g. the
        // admin's, when the org default points at a Copilot model) belongs to
        // whoever configured it and isn't usable by — or visible to — the acting
        // user. Persist the model alone; the acting user's own credential is
        // resolved per-user at request time (or a connect prompt is surfaced).
        chatApiKeyId: providerRequiresPerUserCredential(model.provider)
          ? null
          : (resolved.apiKeyId ?? null),
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
): Promise<{
  model: string;
  provider: SupportedProvider;
  inputModalities: ModelInputModality[] | null;
}> {
  if (modelId) {
    const model = await ModelModel.findById(modelId);
    if (model) {
      return {
        model: model.modelId,
        provider: model.provider,
        inputModalities: model.inputModalities,
      };
    }
  }
  return { ...resolveDefaultLlmFromEnv(), inputModalities: null };
}

/**
 * Resolve the best available LLM provider, API key, model, and base URL by
 * iterating configured providers and checking DB-managed keys.
 *
 * Returns null if no provider has both a key and a synced model.
 *
 * One rung of the resolution chain, not an entry point: it knows nothing about
 * an agent's own configuration or the organization default. Callers resolving
 * an LLM for a built-in subagent want `resolveAgentLlmOrDefault`, which walks
 * the whole chain and ends here.
 *
 * @public — exercised by llm-resolution.test.ts (knip --production ignores tests)
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

    // A subscription credential only works through the proxy adapter, not the
    // direct AI-SDK path this selection feeds (built-in subagents). Skip it so
    // resolution falls through to a usable provider instead of handing the
    // marker to createDirectLLMModel.
    if (chatApiKeyId && !isSubscriptionCredential(apiKey)) {
      const bestModel =
        await LlmProviderApiKeyModelLinkModel.getBestModel(chatApiKeyId);
      if (bestModel) {
        return {
          provider,
          apiKey,
          modelName: bestModel.modelId,
          baseUrl,
          chatApiKeyId,
        };
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
          chatApiKeyId: systemKey.id,
        };
      }
    }
  }

  return null;
}

/**
 * A `(model, key)` pair an agent pins in its own configuration. Both halves are
 * FKs, so a deleted row is simply NULL and the level is skipped.
 */
interface PinnedLlmSelection {
  llmApiKeyId: string | null;
  modelId: string | null;
}

/**
 * The LLM of the work a built-in subagent is serving.
 *
 * Only the MODEL is inherited. The key is always re-resolved for the acting
 * user, because the key a conversation carries is one the user picked in the
 * model selector, and `getCurrentApiKey` re-checks their access to it on every
 * use. Handing that stored secret out directly — as an agent's own configured
 * key legitimately is, since permission there flows through agent access —
 * would let a background title or compaction keep billing a team-scoped key
 * after the user lost access to the team.
 */
interface InheritedLlmSelection {
  modelId: string | null;
  /**
   * The serving AGENT's own key, as the resolution hint — never a
   * conversation's. `getCurrentApiKey` reads it to decide whether the
   * conversation's key IS the agent's key, which is the one case where the
   * per-user access check is intentionally skipped.
   */
  agentLlmApiKeyId?: string | null;
}

/**
 * Resolve an agent's explicitly configured LLM (its `modelId` FK and API key),
 * including the API key secret. Returns null when the agent has no usable
 * configuration.
 *
 * NOT a complete resolution, and never the final answer for a caller about to
 * make a request. This helper is ownership-blind: it returns a selection with
 * `apiKey: undefined` whenever the credential belongs to an individual rather
 * than the organization (a subscription connection, a per-user provider) or
 * when the agent pins a model without a key, leaving the caller to re-resolve
 * the credential for the acting user. Treating that half-resolved selection as
 * final yields a selection that looks configured and fails every call.
 * `resolveAgentLlmOrDefault` is the entry point that completes it.
 *
 * @public — exercised by llm-resolution.test.ts (knip --production ignores tests)
 */
export async function resolveConfiguredAgentLlm(
  agent: PinnedLlmSelection,
): Promise<ResolvedLlmSelection | null> {
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
      // A subscription credential is likewise one person's token — per-user at
      // the KEY level on a provider that also takes API keys, only detectable
      // on the decrypted secret. This helper doesn't know the acting user, so
      // never hand the credential out from here; the fall-through resolution
      // enforces ownership (owner gets this same key back, anyone else gets
      // their own subscription or the connect prompt).
      if (apiKey !== undefined && isSubscriptionCredential(apiKey)) {
        apiKey = undefined;
      }
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
      // Only claim the row when its secret is actually being handed out; a
      // per-user/codex fall-through resolves a different user's key later.
      chatApiKeyId: apiKey !== undefined ? apiKeyRecord.id : undefined,
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
 * back to the inherited selection (see `inheritFrom`), then to
 * organization/default resolution.
 */
export async function resolveAgentLlmOrDefault(params: {
  agent?: PinnedLlmSelection | null;
  /**
   * The LLM the work being served already runs on — the conversation's model
   * for a chat subagent, the calling agent's model for an A2A run.
   *
   * Consulted after `agent`'s own configuration and before the organization
   * default, so a built-in subagent nobody has pinned a model on follows the
   * agent it is working for instead of jumping to whatever the org default
   * happens to be. Without it, an agent running on one self-hosted model has
   * its titles summarized and its context compacted on another — silently,
   * because no error is raised when the org default is merely different rather
   * than unusable.
   */
  inheritFrom?: InheritedLlmSelection | null;
  organizationId: string;
  userId?: string;
  conversationId?: string;
}): Promise<ResolvedLlmSelection> {
  // 1. What the subagent itself is configured with.
  if (params.agent) {
    const configuredLlm = await resolveConfiguredAgentLlm(params.agent);
    if (configuredLlm) {
      return withResolvedKey(configuredLlm, params.agent.llmApiKeyId, params);
    }
  }

  // 2. The model the served work runs on — model only, key re-resolved under
  //    the acting user. See InheritedLlmSelection for why the key is not taken.
  if (params.inheritFrom?.modelId) {
    const model = await ModelModel.findById(params.inheritFrom.modelId);
    if (model) {
      return withResolvedKey(
        {
          provider: model.provider,
          apiKey: undefined,
          modelName: model.modelId,
          baseUrl: null,
        },
        params.inheritFrom.agentLlmApiKeyId ?? null,
        params,
      );
    }
  }

  return resolveDefaultLlmSelection(params);
}

/**
 * Resolve the default LLM for built-in subagent operations that have nothing
 * to inherit from: organization default first, then best available DB-backed
 * model, then the env/Vertex/config fallback used during bootstrap.
 */
async function resolveDefaultLlmSelection(params: {
  organizationId: string;
  userId?: string;
}): Promise<ResolvedLlmSelection> {
  const organization = await OrganizationModel.getById(params.organizationId);

  if (organization?.defaultModelId && organization.defaultLlmApiKeyId) {
    const model = await ModelModel.findById(organization.defaultModelId);
    if (model) {
      const { apiKey, baseUrl, chatApiKeyId } = await resolveProviderApiKey({
        organizationId: params.organizationId,
        userId: params.userId,
        provider: model.provider,
        agentLlmApiKeyId: organization.defaultLlmApiKeyId,
        modelName: model.modelId,
      });
      return {
        provider: model.provider,
        apiKey,
        modelName: model.modelId,
        baseUrl,
        chatApiKeyId,
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
 * Fill in the provider API key for a selection that pins a model but carries no
 * usable secret of its own, resolving it for the acting user.
 */
async function withResolvedKey(
  selection: ResolvedLlmSelection,
  agentLlmApiKeyId: string | null,
  params: {
    organizationId: string;
    userId?: string;
    conversationId?: string;
  },
): Promise<ResolvedLlmSelection> {
  // Providers whose keys are servers (vLLM, Ollama, …) need resolution even
  // when the selection's own key already yielded a credential: the agent may be
  // pinned to one endpoint while its model lives on a sibling one, and only
  // the endpoint that hosts the model can answer for it. Resolution is given
  // the agent's key, so it still wins whenever it does serve the model.
  const resolveEndpointByModel =
    providerHasEndpointLocalModels(selection.provider) &&
    Boolean(selection.modelName);
  const fallbackKey =
    selection.apiKey && !resolveEndpointByModel
      ? null
      : await resolveProviderApiKey({
          organizationId: params.organizationId,
          userId: params.userId,
          provider: selection.provider,
          // A working agent key still outranks the conversation's here: this
          // branch exists to correct the endpoint, not to re-rank ownership.
          conversationId: selection.apiKey ? null : params.conversationId,
          agentLlmApiKeyId,
          modelName: selection.modelName,
        });

  // Landing on another row means another server, whose credential and base
  // URL describe that server and have to travel together. Scoped to the
  // endpoint-local providers: elsewhere a row is an account, and which base
  // URL wins is not this change's business.
  const movedToAnotherEndpoint =
    resolveEndpointByModel &&
    fallbackKey?.chatApiKeyId != null &&
    fallbackKey.chatApiKeyId !== (selection.chatApiKeyId ?? agentLlmApiKeyId);

  if (movedToAnotherEndpoint) {
    return {
      ...selection,
      apiKey: fallbackKey.apiKey,
      chatApiKeyId: fallbackKey.chatApiKeyId,
      baseUrl: fallbackKey.baseUrl ?? null,
    };
  }

  return {
    ...selection,
    apiKey: selection.apiKey ?? fallbackKey?.apiKey,
    // Identity travels with whichever row's secret is used.
    chatApiKeyId: selection.apiKey
      ? selection.chatApiKeyId
      : fallbackKey?.chatApiKeyId,
    baseUrl: selection.baseUrl ?? fallbackKey?.baseUrl ?? null,
  };
}

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
