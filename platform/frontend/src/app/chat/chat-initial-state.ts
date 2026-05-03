import {
  type ModelSource,
  resolveInitialModel,
  resolveModelForAgent,
} from "@/lib/chat/use-chat-preferences";
import type { LlmModel } from "@/lib/llm-models.query";
import type { SupportedProvider } from "@/lib/llm-provider-api-keys.query";

type AgentInfo = {
  id: string;
  llmModel?: string | null;
  llmApiKeyId?: string | null;
};

type ChatApiKeyInfo = {
  id: string;
  provider: string;
};

type OrganizationInfo = {
  defaultLlmModel?: string | null;
  defaultLlmApiKeyId?: string | null;
} | null;

export type ResolvedInitialAgentState = {
  agentId: string;
  modelId: string;
  apiKeyId: string | null;
  modelSource: ModelSource | null;
};

export type ResolvedChatModelState = {
  modelId: string;
  apiKeyId: string | null;
  modelSource: ModelSource | null;
  provider: SupportedProvider | undefined;
};

export type CreateConversationInput = {
  agentId: string;
  selectedModel?: string;
  selectedProvider?: SupportedProvider;
  chatApiKeyId?: string | null;
};

export function resolveInitialAgentSelection<TAgent extends AgentInfo>(params: {
  agents: TAgent[];
  organizationDefaultAgentId?: string | null;
  savedAgentId?: string | null;
  memberDefaultAgentId?: string | null;
  canUseSavedAgent: boolean;
}): TAgent | null {
  const { agents } = params;
  if (agents.length === 0) {
    return null;
  }

  const organizationDefaultAgent = agents.find(
    (agent) => agent.id === params.organizationDefaultAgentId,
  );
  if (organizationDefaultAgent) {
    return organizationDefaultAgent;
  }

  if (params.canUseSavedAgent) {
    const savedAgent = agents.find((agent) => agent.id === params.savedAgentId);
    if (savedAgent) {
      return savedAgent;
    }
  }

  const memberDefaultAgent = agents.find(
    (agent) => agent.id === params.memberDefaultAgentId,
  );
  if (memberDefaultAgent) {
    return memberDefaultAgent;
  }

  return agents[0];
}

export function resolveInitialAgentState(params: {
  agent: AgentInfo;
  modelsByProvider: Record<string, LlmModel[]>;
  chatApiKeys: ChatApiKeyInfo[];
  organization: OrganizationInfo;
}): ResolvedInitialAgentState | null {
  const resolved = resolveChatModelState({
    agent: params.agent,
    modelsByProvider: params.modelsByProvider,
    chatApiKeys: params.chatApiKeys,
    organization: params.organization,
  });

  if (!resolved) {
    return null;
  }

  return {
    agentId: params.agent.id,
    modelId: resolved.modelId,
    apiKeyId: resolved.apiKeyId,
    modelSource: resolved.modelSource,
  };
}

export function getProviderForModelId(params: {
  modelId: string;
  chatModels: LlmModel[];
}): SupportedProvider | undefined {
  return params.chatModels.find((model) => model.id === params.modelId)
    ?.provider;
}

export function resolveChatModelState(params: {
  agent: AgentInfo | null;
  modelsByProvider: Record<string, LlmModel[]>;
  chatApiKeys: ChatApiKeyInfo[];
  organization: OrganizationInfo;
  chatModels?: LlmModel[];
}): ResolvedChatModelState | null {
  const resolved = params.agent
    ? resolveModelForAgent({
        agent: params.agent,
        context: {
          modelsByProvider: params.modelsByProvider,
          chatApiKeys: params.chatApiKeys,
          organization: params.organization,
        },
      })
    : resolveInitialModel({
        modelsByProvider: params.modelsByProvider,
        chatApiKeys: params.chatApiKeys,
        organization: params.organization,
        agent: null,
      });

  if (!resolved) {
    return null;
  }

  return {
    modelId: resolved.modelId,
    apiKeyId: resolved.apiKeyId,
    modelSource: resolved.source === "fallback" ? null : resolved.source,
    provider:
      params.chatModels && params.chatModels.length > 0
        ? getProviderForModelId({
            modelId: resolved.modelId,
            chatModels: params.chatModels,
          })
        : undefined,
  };
}

export function resolvePreferredModelForProvider(params: {
  provider: SupportedProvider;
  modelsByProvider: Record<string, LlmModel[]>;
}): { modelId: string; provider: SupportedProvider } | null {
  const providerModels = params.modelsByProvider[params.provider];
  if (!providerModels || providerModels.length === 0) {
    return null;
  }

  const bestModel = providerModels.find((model) => model.isBest);

  return {
    modelId: bestModel?.id ?? providerModels[0].id,
    provider: params.provider,
  };
}

export function buildCreateConversationInput(params: {
  agentId: string | null;
  modelId: string;
  chatApiKeyId: string | null;
  chatModels: LlmModel[];
}): CreateConversationInput | null {
  if (!params.agentId) {
    return null;
  }

  const selectedProvider = params.modelId
    ? getProviderForModelId({
        modelId: params.modelId,
        chatModels: params.chatModels,
      })
    : undefined;

  return {
    agentId: params.agentId,
    selectedModel: params.modelId || undefined,
    selectedProvider,
    chatApiKeyId: params.chatApiKeyId ?? undefined,
  };
}

export function shouldResetInitialChatState(params: {
  previousRouteConversationId?: string;
  routeConversationId?: string;
}): boolean {
  return !params.routeConversationId && !!params.previousRouteConversationId;
}
