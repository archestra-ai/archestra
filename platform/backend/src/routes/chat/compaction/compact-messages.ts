import {
  CONTEXT_COMPACTION_AUTO_THRESHOLD,
  type SupportedProvider,
} from "@archestra/shared";
import type { ToolSet } from "ai";
import logger from "@/logging";
import { ConversationCompactionModel, ModelModel } from "@/models";
import { resolveCompactionLlm } from "@/services/compaction-llm";
import {
  chooseRecentSuffixStart,
  summarizeCompactionTranscript,
} from "@/services/context-compaction";
import type { ChatMessage } from "@/types";
import type {
  ContextCompactionReason,
  ContextCompactionStatus,
  ConversationCompaction,
  ConversationCompactionTrigger,
} from "@/types/conversation-compaction";
import {
  buildSummaryMessage,
  getCompactionBoundaryIds,
  resolveCompactionBoundaryMessageId,
  resolveUsableCompaction,
  splitMessagesForCompaction,
} from "./history";
import { summarizeInContext } from "./in-context";
import {
  buildCompactionPrompt,
  estimateChatMessagesTokens,
} from "./message-text";
import { traceContextCompaction } from "./tracing";

type ContextCompactionParams = {
  conversationId: string;
  organizationId: string;
  userId: string;
  agentId?: string | null;
  provider: SupportedProvider;
  selectedModel: string;
  /**
   * The conversation's `models` FK — the row `provider` / `selectedModel` were
   * dereferenced from. Carried so the summary can be written by the model the
   * conversation runs on when the compaction subagent pins none of its own;
   * the dereferenced pair alone cannot say whether it came from a real row or
   * from the env fallback.
   */
  modelId?: string | null;
  agentLlmApiKeyId?: string | null;
  messages: ChatMessage[];
  systemPrompt?: string;
  /** AI SDK tool definitions included in the main model request. */
  tools?: ToolSet;
  /**
   * `auto` runs on every chat turn: it compacts only past the threshold and
   * first tries summarizing in context. `manual` always compacts, via the
   * transcript summarizer.
   */
  trigger: ConversationCompactionTrigger;
  onCompactionStart?: () => void;
  abortSignal?: AbortSignal;
};

export type ContextCompactionResult = {
  messages: ChatMessage[];
  status: ContextCompactionStatus;
  compaction: ConversationCompaction | null;
  reason?: ContextCompactionReason;
  // estimated tokens of `messages` (what is actually sent to the model this
  // turn), on the same yardstick as the auto-compaction threshold. Drives the
  // live context indicator.
  inputTokenEstimate?: number;
};

export type ContextCompactionStreamData = {
  status: ContextCompactionStatus;
  reason?: ContextCompactionReason;
  compactionId?: string;
  trigger?: ConversationCompactionTrigger;
  originalTokenEstimate?: number;
  compactedTokenEstimate?: number;
};

export async function compactMessagesForChat(
  params: ContextCompactionParams,
): Promise<ContextCompactionResult> {
  return await traceContextCompaction(params, async () => {
    const result = await runCompaction(params);
    return {
      ...result,
      inputTokenEstimate:
        result.inputTokenEstimate ??
        estimateChatMessagesTokens({
          provider: params.provider,
          model: params.selectedModel,
          systemPrompt: params.systemPrompt,
          tools: params.tools,
          messages: result.messages,
        }),
    };
  });
}

export function buildContextCompactionStreamData(
  result: ContextCompactionResult,
): ContextCompactionStreamData {
  const base = {
    status: result.status,
    ...(result.reason ? { reason: result.reason } : {}),
  };

  if (result.status !== "created" || !result.compaction) {
    return base;
  }

  return {
    ...base,
    compactionId: result.compaction.id,
    trigger: result.compaction.trigger,
    originalTokenEstimate: result.compaction.originalTokenEstimate,
    compactedTokenEstimate: result.compaction.compactedTokenEstimate,
  };
}

// =============================================================================
// Internal Helpers
// =============================================================================

async function runCompaction(
  params: ContextCompactionParams,
): Promise<ContextCompactionResult> {
  // What is sent when no new summary is created: the history with the latest
  // usable stored summary applied. Failures keep it rather than dropping a
  // summary that already fit the window.
  let current: {
    messages: ChatMessage[];
    compaction: ConversationCompaction | null;
  } = { messages: params.messages, compaction: null };
  const keepCurrent = (
    reason: ContextCompactionReason,
  ): ContextCompactionResult => ({
    messages: current.messages,
    status: current.compaction ? "existing" : "skipped",
    compaction: current.compaction,
    reason,
  });

  try {
    const latest = await ConversationCompactionModel.findLatestByConversation(
      params.conversationId,
    );
    const usable = resolveUsableCompaction(
      params.messages,
      latest,
      await getCompactionBoundaryIds(latest, params.conversationId),
    );
    if (latest && !usable.compaction) {
      logger.warn(
        {
          conversationId: params.conversationId,
          compactionId: latest.id,
          compactedThroughMessageId: latest.compactedThroughMessageId,
        },
        "[ContextCompaction] ignoring stale compaction with missing boundary message",
      );
    }
    current = usable;

    // auto keeps a token-budgeted recent tail verbatim; manual compacts
    // everything except a still-unanswered user turn
    let recentTailBudget: number | null = null;
    if (params.trigger === "auto") {
      const decision = await checkAutoThreshold({
        provider: params.provider,
        selectedModel: params.selectedModel,
        systemPrompt: params.systemPrompt,
        tools: params.tools,
        messages: current.messages,
      });
      if (!decision.shouldCompact) {
        return {
          ...keepCurrent(
            current.compaction ? "using_existing_summary" : "below_threshold",
          ),
          inputTokenEstimate: decision.estimatedTokens,
        };
      }
      recentTailBudget = Math.min(
        decision.budgetTokens * RECENT_TAIL_BUDGET_RATIO,
        RECENT_TAIL_MAX_TOKENS,
      );
    }

    const sourceMessages = params.messages.slice(usable.boundaryIndex + 1);
    const split =
      recentTailBudget === null
        ? splitMessagesForCompaction(sourceMessages)
        : splitRecentTail({
            messages: sourceMessages,
            keepBudget: recentTailBudget,
            provider: params.provider,
            selectedModel: params.selectedModel,
          });
    const boundaryMessage = split.compactable.at(-1);
    if (!boundaryMessage) {
      return keepCurrent("nothing_to_compact");
    }

    // boundary id is the anchor used to align the summary with the live
    // message list later; without it, a compaction would be unrecoverable
    const boundaryMessageId = await resolveCompactionBoundaryMessageId(
      boundaryMessage,
      params.conversationId,
    );
    if (!boundaryMessageId) {
      logger.warn(
        { conversationId: params.conversationId, trigger: params.trigger },
        "[ContextCompaction] last compactable message has no id; skipping compaction",
      );
      return keepCurrent("missing_boundary_message_id");
    }

    if (params.abortSignal?.aborted) {
      return keepCurrent("aborted");
    }

    params.onCompactionStart?.();
    const compaction = await createConversationCompaction({
      ...params,
      previousSummary: current.compaction?.summary ?? null,
      sourceMessages,
      compactableMessages: split.compactable,
      recentMessages: split.recent,
      boundaryMessageId,
    });
    if (!compaction) {
      return keepCurrent("not_beneficial");
    }

    return {
      messages: [buildSummaryMessage(compaction.summary), ...split.recent],
      status: "created",
      compaction,
    };
  } catch (error) {
    if (params.abortSignal?.aborted) {
      return keepCurrent("aborted");
    }
    logger.warn(
      { error, conversationId: params.conversationId, trigger: params.trigger },
      "[ContextCompaction] failed to compact chat history",
    );
    return {
      ...keepCurrent("summary_generation_failed"),
      status: "failed",
    };
  }
}

async function checkAutoThreshold(params: {
  provider: SupportedProvider;
  selectedModel: string;
  systemPrompt?: string;
  tools?: Record<string, unknown>;
  messages: ChatMessage[];
}): Promise<
  | { shouldCompact: false; estimatedTokens: number }
  | { shouldCompact: true; estimatedTokens: number; budgetTokens: number }
> {
  const estimatedTokens = estimateChatMessagesTokens({
    ...params,
    model: params.selectedModel,
  });
  const model = await ModelModel.findByProviderAndModelId(
    params.provider,
    params.selectedModel,
  );
  // The resolved window, not the raw column: an Ollama model capped by its
  // Modelfile (or a configured `num_ctx`) truncates long before the
  // architectural limit, so thresholding on the raw value means compaction
  // never fires and the conversation silently loses its head.
  const contextLength = model
    ? ModelModel.resolveEffectiveContextLength(model)
    : null;
  const budgetTokens = contextLength
    ? contextLength * CONTEXT_COMPACTION_AUTO_THRESHOLD
    : null;

  return budgetTokens !== null && estimatedTokens >= budgetTokens
    ? { shouldCompact: true, estimatedTokens, budgetTokens }
    : { shouldCompact: false, estimatedTokens };
}

/**
 * Keep the newest messages that fit `keepBudget` tokens verbatim (always at
 * least the newest, so a pending user turn is never summarized away).
 */
function splitRecentTail(params: {
  messages: ChatMessage[];
  keepBudget: number;
  provider: SupportedProvider;
  selectedModel: string;
}): { compactable: ChatMessage[]; recent: ChatMessage[] } {
  const start = chooseRecentSuffixStart({
    count: params.messages.length,
    sizeOf: (index) =>
      estimateChatMessagesTokens({
        provider: params.provider,
        model: params.selectedModel,
        messages: [params.messages[index]],
      }),
    keepBudget: params.keepBudget,
  });
  return {
    compactable: params.messages.slice(0, start),
    recent: params.messages.slice(start),
  };
}

async function createConversationCompaction(
  params: ContextCompactionParams & {
    previousSummary: string | null;
    sourceMessages: ChatMessage[];
    compactableMessages: ChatMessage[];
    recentMessages: ChatMessage[];
    boundaryMessageId: string;
  },
): Promise<ConversationCompaction | null> {
  const record = (summary: { text: string; provider: string; model: string }) =>
    createCompactionRecord({ ...params, summary });

  if (params.trigger === "auto") {
    const inContextSummary = await summarizeInContext(params);
    const compaction = inContextSummary
      ? await record({
          text: inContextSummary,
          provider: params.provider,
          model: params.selectedModel,
        })
      : null;
    if (compaction) {
      return compaction;
    }
  }

  if (params.abortSignal?.aborted) {
    throw new Error("Compaction aborted before fallback transcript request");
  }

  // The fallback inherits the conversation's model unless an admin pinned one
  // on the compaction subagent, so which model writes a summary does not
  // depend on which path ran.
  const compactionLlm = await resolveCompactionLlm({
    organizationId: params.organizationId,
    userId: params.userId,
    inheritFrom: {
      modelId: params.modelId ?? null,
      agentLlmApiKeyId: params.agentLlmApiKeyId ?? null,
    },
    fallbackAgentId: params.agentId ?? params.conversationId,
    conversationId: params.conversationId,
    sessionId: params.conversationId,
    source: "chat:compaction",
  });
  if (!compactionLlm) {
    throw new Error("LLM provider API key not configured");
  }

  // Last-resort flow: salvage untagged output rather than fail the compaction.
  const summary = await summarizeCompactionTranscript({
    model: compactionLlm.model,
    prompt: await buildCompactionPrompt({
      previousSummary: params.previousSummary,
      messages: params.compactableMessages,
      conversationId: params.conversationId,
    }),
    systemPrompt: compactionLlm.systemPrompt,
    abortSignal: params.abortSignal,
    salvageUntagged: true,
  });
  if (!summary) {
    throw new Error("Compaction summary was empty");
  }

  return await record({
    text: summary,
    provider: compactionLlm.provider,
    model: compactionLlm.modelName,
  });
}

/**
 * Persist the summary when it shrinks the history; null when it does not.
 * Both estimates are on the conversation model's yardstick, whichever model
 * wrote the summary.
 */
async function createCompactionRecord(params: {
  conversationId: string;
  provider: SupportedProvider;
  selectedModel: string;
  trigger: ConversationCompactionTrigger;
  previousSummary: string | null;
  sourceMessages: ChatMessage[];
  recentMessages: ChatMessage[];
  boundaryMessageId: string;
  summary: { text: string; provider: string; model: string };
}): Promise<ConversationCompaction | null> {
  const estimate = (messages: ChatMessage[]) =>
    estimateChatMessagesTokens({
      provider: params.provider,
      model: params.selectedModel,
      messages,
    });
  const originalTokenEstimate = estimate(
    params.previousSummary
      ? [buildSummaryMessage(params.previousSummary), ...params.sourceMessages]
      : params.sourceMessages,
  );
  // mirrors the message list the caller will send to the model next turn:
  // summary + the same "recent" slice that was kept verbatim
  const compactedTokenEstimate = estimate([
    buildSummaryMessage(params.summary.text),
    ...params.recentMessages,
  ]);

  if (compactedTokenEstimate >= originalTokenEstimate) {
    logger.info(
      {
        conversationId: params.conversationId,
        trigger: params.trigger,
        originalTokenEstimate,
        compactedTokenEstimate,
      },
      "[ContextCompaction] skipping non-beneficial compaction summary",
    );
    return null;
  }

  return await ConversationCompactionModel.create({
    conversationId: params.conversationId,
    summary: params.summary.text,
    compactedThroughMessageId: params.boundaryMessageId,
    trigger: params.trigger,
    provider: params.summary.provider,
    model: params.summary.model,
    originalTokenEstimate,
    compactedTokenEstimate,
  });
}

// Verbatim recent tail kept by auto compaction: a share of the threshold
// budget, capped so large windows still compact most of the history.
const RECENT_TAIL_BUDGET_RATIO = 0.25;
const RECENT_TAIL_MAX_TOKENS = 20_000;
