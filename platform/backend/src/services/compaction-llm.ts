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
import logger from "@/logging";
import { AgentModel, ModelModel } from "@/models";
import type { TranscriptToolOutput } from "@/services/context-compaction";
import { isGuardrailsV2Active } from "@/services/guardrails-deployment";
import { renderSystemPrompt } from "@/templating";
import { resolveAgentLlmOrDefault } from "@/utils/llm-resolution";

/** Compaction transcripts carry tool outputs only while OpenAPPA reads off. */
export async function compactionTranscriptToolOutput(): Promise<TranscriptToolOutput> {
  try {
    return (await isGuardrailsV2Active()) ? "withheld" : "included";
  } catch (error) {
    logger.warn(
      { error },
      "[ContextCompaction] could not read the OpenAPPA switch; withholding tool output from the transcript",
    );
    return "withheld";
  }
}

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
  /** The summarizer model's effective window; null when unknown. */
  contextLength: number | null;
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
  const modelRow = await ModelModel.findByProviderAndModelId(
    llm.provider,
    llm.modelName,
  ).catch(() => null);

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
    contextLength: modelRow
      ? ModelModel.resolveEffectiveContextLength(modelRow)
      : null,
  };
}
