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
  provider: SupportedProvider;
  bestModelId?: string | null;
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

export function resolveInitialAgentState(params: {
  agent: AgentInfo;
  chatApiKeys: ChatApiKeyInfo[];
  organization: OrganizationInfo;
}): ResolvedInitialAgentState | null {
  const resolved = resolveChatModelState({
    agent: params.agent,
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

export function resolveChatModelState(params: {
  agent: AgentInfo | null;
  chatApiKeys: ChatApiKeyInfo[];
  organization: OrganizationInfo;
  selectedModelMetadata?: LlmModel | null;
}): ResolvedChatModelState | null {
  const resolved = params.agent
    ? resolveModelForAgent({
        agent: params.agent,
        context: {
          chatApiKeys: params.chatApiKeys,
          organization: params.organization,
        },
      })
    : resolveInitialModel({
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
      params.selectedModelMetadata?.id === resolved.modelId
        ? params.selectedModelMetadata.provider
        : getProviderForApiKeyId({
            apiKeyId: resolved.apiKeyId,
            chatApiKeys: params.chatApiKeys,
          }),
  };
}

export function resolvePreferredModelForProvider(params: {
  provider: SupportedProvider;
  apiKeyId: string;
  chatApiKeys: ChatApiKeyInfo[];
}): { modelId: string; provider: SupportedProvider } | null {
  const selectedKey = params.chatApiKeys.find(
    (key) => key.id === params.apiKeyId && key.provider === params.provider,
  );
  if (!selectedKey?.bestModelId) {
    return null;
  }

  return {
    modelId: selectedKey.bestModelId,
    provider: params.provider,
  };
}

export function buildCreateConversationInput(params: {
  agentId: string | null;
  modelId: string;
  chatApiKeyId: string | null;
  selectedModelMetadata?: LlmModel | null;
  selectedProvider?: SupportedProvider;
  chatApiKeys: ChatApiKeyInfo[];
}): CreateConversationInput | null {
  if (!params.agentId) {
    return null;
  }

  const selectedProvider =
    params.selectedProvider ??
    (params.selectedModelMetadata?.id === params.modelId
      ? params.selectedModelMetadata.provider
      : getProviderForApiKeyId({
          apiKeyId: params.chatApiKeyId,
          chatApiKeys: params.chatApiKeys,
        }));

  return {
    agentId: params.agentId,
    selectedModel: params.modelId || undefined,
    selectedProvider,
    chatApiKeyId: params.chatApiKeyId ?? undefined,
  };
}

function getProviderForApiKeyId(params: {
  apiKeyId: string | null;
  chatApiKeys: ChatApiKeyInfo[];
}): SupportedProvider | undefined {
  if (!params.apiKeyId) return undefined;
  return params.chatApiKeys.find((key) => key.id === params.apiKeyId)?.provider;
}

export function shouldResetInitialChatState(params: {
  previousRouteConversationId?: string;
  routeConversationId?: string;
}): boolean {
  return !params.routeConversationId && !!params.previousRouteConversationId;
}
