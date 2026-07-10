import {
  resolveInitialModel,
  resolveModelForAgent,
} from "@/lib/chat/use-chat-preferences";
import type { LlmModel } from "@/lib/llm-models.query";
import type { SupportedProvider } from "@/lib/llm-provider-api-keys.query";

type AgentInfo = {
  id: string;
  modelId?: string | null;
  llmApiKeyId?: string | null;
};

type ChatApiKeyInfo = {
  id: string;
  provider: string;
};

type OrganizationInfo = {
  defaultModelId?: string | null;
  defaultLlmApiKeyId?: string | null;
} | null;

/** The current user's saved default (model, key) pair — the "member" level. */
type MemberDefaultInfo = {
  modelId?: string | null;
  chatApiKeyId?: string | null;
} | null;

/** A model identifier is the models.id UUID throughout the chat model flow. */
export type ResolvedInitialAgentState = {
  agentId: string;
  modelId: string;
  apiKeyId: string | null;
};

export type ResolvedChatModelState = {
  modelId: string;
  apiKeyId: string | null;
};

export type CreateConversationInput = {
  agentId: string;
  modelId?: string;
  chatApiKeyId?: string | null;
  title?: string;
  /** Project the chat is started in (carried from /chat?project=...). */
  projectId?: string;
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
  memberDefault: MemberDefaultInfo;
}): ResolvedInitialAgentState | null {
  const resolved = resolveChatModelState({
    agent: params.agent,
    modelsByProvider: params.modelsByProvider,
    chatApiKeys: params.chatApiKeys,
    organization: params.organization,
    memberDefault: params.memberDefault,
  });

  if (!resolved) {
    return null;
  }

  return {
    agentId: params.agent.id,
    modelId: resolved.modelId,
    apiKeyId: resolved.apiKeyId,
  };
}

export function resolveChatModelState(params: {
  agent: AgentInfo | null;
  modelsByProvider: Record<string, LlmModel[]>;
  chatApiKeys: ChatApiKeyInfo[];
  organization: OrganizationInfo;
  memberDefault: MemberDefaultInfo;
}): ResolvedChatModelState | null {
  // The resolver identifies models by their models.id UUID.
  const modelsByProvider = Object.fromEntries(
    Object.entries(params.modelsByProvider).map(([provider, models]) => [
      provider,
      models.map((m) => ({ id: m.dbId, isBest: m.isBest })),
    ]),
  );

  const resolved = params.agent
    ? resolveModelForAgent({
        agent: params.agent,
        context: {
          modelsByProvider,
          chatApiKeys: params.chatApiKeys,
          organization: params.organization,
          memberDefault: params.memberDefault,
        },
      })
    : resolveInitialModel({
        modelsByProvider,
        chatApiKeys: params.chatApiKeys,
        organization: params.organization,
        memberDefault: params.memberDefault,
        agent: null,
      });

  if (!resolved) {
    return null;
  }

  return {
    modelId: resolved.modelId,
    apiKeyId: resolved.apiKeyId,
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
    modelId: bestModel?.dbId ?? providerModels[0].dbId,
    provider: params.provider,
  };
}

export function buildCreateConversationInput(params: {
  agentId: string | null;
  modelId: string;
  chatApiKeyId: string | null;
  title?: string;
  projectId?: string | null;
}): CreateConversationInput | null {
  if (!params.agentId) {
    return null;
  }

  return {
    agentId: params.agentId,
    modelId: params.modelId || undefined,
    chatApiKeyId: params.chatApiKeyId ?? undefined,
    title: params.title,
    projectId: params.projectId ?? undefined,
  };
}

export function shouldResetInitialChatState(params: {
  previousRouteConversationId?: string;
  routeConversationId?: string;
}): boolean {
  return !params.routeConversationId && !!params.previousRouteConversationId;
}

/**
 * Whether `/chat` is mid-handoff: it arrived carrying a `user_prompt` (or a
 * stashed-attachments marker whose files are still in memory) and is about to —
 * or already is — auto-creating a conversation before navigating to
 * `/chat/<id>`. During this window the centered New Chat splash must not render,
 * or the empty home flashes before the conversation view mounts.
 *
 * Mirrors the auto-send effect's trigger conditions. `autoSendTriggered` (the
 * effect's ref, set synchronously before the create fires) keeps it true from
 * the frame where `user_prompt` is stripped from the URL through the whole
 * create request. A files-only handoff whose stashed files were lost (e.g. a
 * hard reload) has no prompt and no pending files, so this stays false and the
 * composer shows.
 *
 * Deliberately NOT keyed on the create mutation being pending: an interactive
 * submit from the splash also runs that mutation, and the splash must stay on
 * screen during it — the composer keeps focus and is the "old" half of the
 * shared-element morph into the conversation view. Only true handoffs (which
 * always set one of the signals below) suppress the splash.
 */
export function isAutoSendHandoffInProgress(params: {
  conversationId?: string;
  initialUserPrompt?: string;
  hasAttachmentsMarker: boolean;
  hasPendingHandoffFiles: boolean;
  autoSendTriggered: boolean;
}): boolean {
  if (params.conversationId) {
    return false;
  }

  return (
    Boolean(params.initialUserPrompt) ||
    (params.hasAttachmentsMarker && params.hasPendingHandoffFiles) ||
    params.autoSendTriggered
  );
}
