import {
  type ModelSource,
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

export function resolveInitialAgentState(params: {
  agent: AgentInfo;
  modelsByProvider: Record<string, LlmModel[]>;
  chatApiKeys: ChatApiKeyInfo[];
  organization: OrganizationInfo;
}): ResolvedInitialAgentState | null {
  const { agent, modelsByProvider, chatApiKeys, organization } = params;
  const resolved = resolveModelForAgent({
    agent,
    context: {
      modelsByProvider,
      chatApiKeys,
      organization,
    },
  });

  if (!resolved) {
    return null;
  }

  return {
    agentId: agent.id,
    modelId: resolved.modelId,
    apiKeyId: resolved.apiKeyId,
    modelSource: resolved.source === "fallback" ? null : resolved.source,
  };
}

export function getProviderForModelId(params: {
  modelId: string;
  chatModels: LlmModel[];
}): SupportedProvider | undefined {
  return params.chatModels.find((model) => model.id === params.modelId)
    ?.provider;
}

export function shouldResetInitialChatState(params: {
  previousRouteConversationId?: string;
  routeConversationId?: string;
}): boolean {
  return !params.routeConversationId && !!params.previousRouteConversationId;
}
