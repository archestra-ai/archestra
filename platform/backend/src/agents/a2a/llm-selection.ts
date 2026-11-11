import type { ModelSelection, SubagentModelTier } from "@archestra/shared";
import { resolveSubagentTierSelection } from "@/agents/subagent-tiers";
import config from "@/config";
import { resolveAgentModelPool } from "@/services/chat-model-pools";
import {
  resolveConversationModel,
  resolveForkParentSelection,
} from "@/utils/llm-resolution";

/**
 * A fork starts from its parent's model, moved to its tier when one is asked
 * for; any other run resolves from the agent's own configuration. A pooled
 * run anchors on a member the caller can use before the client checks its key.
 */
export async function resolveRunLlmSelection(params: {
  agent: {
    llmApiKeyId: string | null;
    modelId: string | null;
    autoRouterId: string | null;
    modelPoolId?: string | null;
    runtime: unknown;
  };
  organizationId: string;
  userId: string;
  selfFork?: boolean;
  parentLlm?: ModelSelection;
  tier?: SubagentModelTier;
}) {
  const { agent } = params;
  if (
    config.llmProxy.modelPoolsEnabled &&
    !params.selfFork &&
    agent.modelPoolId
  ) {
    const pooled = await resolveAgentModelPool({
      organizationId: params.organizationId,
      userId: params.userId,
      modelPoolId: agent.modelPoolId,
    });
    const selected = await resolveConversationModel(pooled.modelId);
    return {
      modelId: pooled.modelId,
      chatApiKeyId: pooled.chatApiKeyId,
      selectedModel: selected.model,
      selectedProvider: selected.provider,
    };
  }
  const { llmApiKeyId, modelId, autoRouterId } = agent;
  const base = await resolveForkParentSelection({
    agent: { llmApiKeyId, modelId, autoRouterId },
    organizationId: params.organizationId,
    userId: params.userId,
    parentLlm: params.parentLlm,
    allowAutoModel: agent.runtime === null,
  });
  return params.tier
    ? resolveSubagentTierSelection({
        tier: params.tier,
        parent: base,
        organizationId: params.organizationId,
        userId: params.userId,
      })
    : base;
}
