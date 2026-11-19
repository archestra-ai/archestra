import {
  getModelReadableMimeTypes,
  type SupportedProvider,
} from "@archestra/shared";
import type { ToolSet } from "ai";
import { isAnthropicNativeEndpoint } from "@/clients/anthropic-endpoint";
import { createLLMModel, isApiKeyRequired } from "@/clients/llm-client";
import { orderToolResultsByCall } from "@/clients/tool-result-order";
import logger from "@/logging";
import { ModelModel } from "@/models";
import {
  CONTEXT_COMPACTION_INSTRUCTION_TOKENS,
  CONTEXT_COMPACTION_MAX_OUTPUT_TOKENS,
  generateInContextSummary,
} from "@/services/context-compaction";
import { isSkillSandboxAvailableForAgent } from "@/skills/skill-sandbox-availability";
import type { ChatMessage } from "@/types";
import { resolveProviderApiKey } from "@/utils/llm-api-key-resolution";
import { applyPromptCacheBreakpoints } from "../normalization/apply-prompt-cache";
import { buildModelMessagesForProvider } from "../normalization/build-model-messages";
import { buildSummaryMessage } from "./history";
import { estimateChatMessagesTokens } from "./message-text";

/**
 * Summarize on the conversation's own model, with the chat system prompt and
 * tools and the native (attachment-materialized) history plus a compaction
 * instruction turn, so the model sees exactly what it has been working with.
 * The history is the one the turn would send, with the same cache
 * breakpoints, so the provider reads it from the prompt cache; only when it
 * leaves no room for the summary does the request drop the recent tail.
 * Returns null on any failure; the caller then falls back to the transcript
 * path.
 */
export async function summarizeInContext(params: {
  conversationId: string;
  organizationId: string;
  userId: string;
  agentId?: string | null;
  provider: SupportedProvider;
  selectedModel: string;
  agentLlmApiKeyId?: string | null;
  previousSummary: string | null;
  compactableMessages: ChatMessage[];
  /** Kept verbatim after the summary; sent so the request matches the turn's cached prefix. */
  recentMessages: ChatMessage[];
  systemPrompt?: string;
  /** The same definitions used by the conversation, without executing tools. */
  tools?: ToolSet;
  abortSignal?: AbortSignal;
}): Promise<string | null> {
  const logFields = {
    conversationId: params.conversationId,
    provider: params.provider,
    model: params.selectedModel,
  };
  try {
    const resolvedKey = await resolveProviderApiKey({
      organizationId: params.organizationId,
      userId: params.userId,
      provider: params.provider,
      conversationId: params.conversationId,
      agentLlmApiKeyId: params.agentLlmApiKeyId,
      modelName: params.selectedModel,
    });
    const apiKey = resolvedKey?.apiKey;
    const baseUrl = resolvedKey?.baseUrl ?? null;
    if (isApiKeyRequired(params.provider, apiKey)) {
      return null;
    }
    const anthropicNativeEndpoint = isAnthropicNativeEndpoint({
      provider: params.provider,
      model: params.selectedModel,
      baseUrl,
    });

    const model = createLLMModel({
      provider: params.provider,
      apiKey,
      agentId: params.agentId ?? params.conversationId,
      modelName: params.selectedModel,
      baseUrl,
      userId: params.userId,
      sessionId: params.conversationId,
      source: "chat:compaction",
      chatApiKeyId: resolvedKey?.chatApiKeyId,
    });
    // Rehydrate attachment refs back to inline bytes before the LLM call —
    // otherwise the compaction model sees ref URLs it can't fetch and
    // summarizes without the file content. Materialize is conversation-scoped
    // so cross-conv refs (if any) are silently dropped. Non-ingestible files
    // are referenced as sandbox paths rather than inlined as documents the
    // compaction model would reject.
    const compactionModelRow = await ModelModel.findByProviderAndModelId(
      params.provider,
      params.selectedModel,
    ).catch(() => null);
    const contextLength = compactionModelRow
      ? ModelModel.resolveEffectiveContextLength(compactionModelRow)
      : null;
    // Gate the sandbox pointers on the chat agent's availability, not the
    // compaction model's tools: the summary feeds the main turn, whose agent
    // can run the sandbox, so a faithful summary must reflect that the file is
    // reachable there. When the agent can't use the sandbox, the pointer is
    // suppressed just like on the main path.
    const sandboxAvailable = await isSkillSandboxAvailableForAgent({
      userId: params.userId,
      organizationId: params.organizationId,
      agentId: params.agentId ?? undefined,
    });
    const compactable: ChatMessage[] = [
      ...(params.previousSummary
        ? [buildSummaryMessage(params.previousSummary)]
        : []),
      ...params.compactableMessages,
    ];
    const turnHistory = [...compactable, ...params.recentMessages];
    const history =
      contextLength === null ||
      estimateChatMessagesTokens({
        provider: params.provider,
        model: params.selectedModel,
        systemPrompt: params.systemPrompt,
        tools: params.tools,
        messages: turnHistory,
      }) +
        CONTEXT_COMPACTION_INSTRUCTION_TOKENS +
        CONTEXT_COMPACTION_MAX_OUTPUT_TOKENS <=
        contextLength
        ? turnHistory
        : compactable;
    // Share the ordinary turn's attachment and tool normalization: rewriting
    // even an unchanged part differently would invalidate the cached prefix.
    const { modelMessages } = await buildModelMessagesForProvider({
      messages: history,
      conversationId: params.conversationId,
      provider: params.provider,
      ingestibleMimeTypes: getModelReadableMimeTypes(
        compactionModelRow?.inputModalities ?? null,
        params.provider,
      ),
      anthropicNativeEndpoint,
      sandboxAvailable,
    });
    const summary = await generateInContextSummary({
      model,
      systemPrompt: params.systemPrompt,
      messages: applyPromptCacheBreakpoints({
        provider: params.provider,
        model: params.selectedModel,
        anthropicNativeEndpoint,
        messages: orderToolResultsByCall(modelMessages),
      }),
      tools: params.tools,
      hasPreviousSummary: params.previousSummary !== null,
      contextLength,
      abortSignal: params.abortSignal,
      logFields,
    });
    if (!summary) {
      throw new Error("In-context compaction response missing summary tag");
    }
    logger.info(
      logFields,
      "[ContextCompaction] in-context compaction succeeded",
    );
    return summary;
  } catch (error) {
    if (!params.abortSignal?.aborted) {
      logger.warn(
        { error, ...logFields },
        "[ContextCompaction] in-context compaction failed; falling back to rendered transcript",
      );
    }
    return null;
  }
}
