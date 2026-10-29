import {
  BUILT_IN_AGENT_IDS,
  CONTEXT_COMPACTION_SYSTEM_PROMPT,
  type InteractionSource,
  type SupportedProvider,
} from "@archestra/shared";
import {
  createLLMModel,
  isApiKeyRequired,
  type LLMModel,
} from "@/clients/llm-client";
import { AgentModel } from "@/models";
import { renderSystemPrompt } from "@/templating";
import { resolveAgentLlmOrDefault } from "@/utils/llm-resolution";

/**
 * Resolve the built-in context-compaction agent into a ready summarizer model
 * and its system prompt. The summary is written by the served work's own
 * model unless an admin pinned one on the compaction subagent. Returns null
 * when the resolved provider has no usable API key.
 */
export async function resolveCompactionLlm(params: {
  organizationId: string;
  userId?: string;
  /** The model and key hint of the work being compacted. */
  inheritFrom: { modelId: string | null; agentLlmApiKeyId: string | null };
  /** Attribution when the compaction agent row is missing. */
  fallbackAgentId: string;
  conversationId?: string;
  sessionId?: string;
  source: InteractionSource;
}): Promise<{
  model: LLMModel;
  provider: SupportedProvider;
  modelName: string;
  systemPrompt: string;
} | null> {
  const compactionAgent = await AgentModel.getBuiltInAgent(
    BUILT_IN_AGENT_IDS.CONTEXT_COMPACTION,
    params.organizationId,
  );
  const llm = await resolveAgentLlmOrDefault({
    agent: compactionAgent,
    inheritFrom: params.inheritFrom,
    organizationId: params.organizationId,
    userId: params.userId,
    conversationId: params.conversationId,
  });
  if (isApiKeyRequired(llm.provider, llm.apiKey)) {
    return null;
  }

  return {
    model: createLLMModel({
      provider: llm.provider,
      apiKey: llm.apiKey,
      agentId: compactionAgent?.id ?? params.fallbackAgentId,
      modelName: llm.modelName,
      baseUrl: llm.baseUrl,
      userId: params.userId,
      sessionId: params.sessionId,
      source: params.source,
      chatApiKeyId: llm.chatApiKeyId,
    }),
    provider: llm.provider,
    modelName: llm.modelName,
    systemPrompt:
      renderSystemPrompt(
        compactionAgent?.systemPrompt ?? CONTEXT_COMPACTION_SYSTEM_PROMPT,
      ) ?? CONTEXT_COMPACTION_SYSTEM_PROMPT,
  };
}
