import { isSupportedProvider, type SupportedProvider } from "@shared";
import { detectProviderFromModel } from "@/clients/llm-client";
import { ApiKeyModelModel, ChatApiKeyModel, OrganizationModel } from "@/models";
import { resolveSmartDefaultLlmForChat } from "@/utils/llm-resolution";

// === Types ===

export interface ConversationLlmSelection {
  chatApiKeyId: string | null;
  selectedModel: string;
  selectedProvider: SupportedProvider;
}

interface AgentLlmConfig {
  llmApiKeyId: string | null;
  llmModel: string | null;
}

// === Exports ===

export async function resolveConversationLlmSelectionForAgent(params: {
  agent: AgentLlmConfig;
  organizationId: string;
  userId: string;
}): Promise<ConversationLlmSelection> {
  const { agent, organizationId, userId } = params;

  const agentSelection = await resolveAgentSelection(agent);
  if (agentSelection) {
    return agentSelection;
  }

  const organizationSelection =
    await resolveOrganizationSelection(organizationId);
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

// === Helpers ===

async function resolveAgentSelection(
  agent: AgentLlmConfig,
): Promise<ConversationLlmSelection | null> {
  if (agent.llmApiKeyId) {
    const apiKey = await ChatApiKeyModel.findById(agent.llmApiKeyId);
    if (apiKey) {
      const provider = isSupportedProvider(apiKey.provider)
        ? apiKey.provider
        : detectProviderFromModel(agent.llmModel ?? "");

      if (agent.llmModel) {
        return {
          chatApiKeyId: apiKey.id,
          selectedModel: agent.llmModel,
          selectedProvider: provider,
        };
      }

      const bestModel = await ApiKeyModelModel.getBestModel(apiKey.id);
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

async function resolveOrganizationSelection(
  organizationId: string,
): Promise<ConversationLlmSelection | null> {
  const organization = await OrganizationModel.getById(organizationId);
  if (!organization?.defaultLlmModel) {
    return null;
  }

  const apiKey = organization.defaultLlmApiKeyId
    ? await ChatApiKeyModel.findById(organization.defaultLlmApiKeyId)
    : null;

  return {
    chatApiKeyId: apiKey?.id ?? null,
    selectedModel: organization.defaultLlmModel,
    selectedProvider:
      organization.defaultLlmProvider &&
      isSupportedProvider(organization.defaultLlmProvider)
        ? organization.defaultLlmProvider
        : detectProviderFromModel(organization.defaultLlmModel),
  };
}
