/**
 * Persisted cross-turn compaction for stateful A2A contexts, mirroring web
 * chat's `conversation_compactions` flow (routes/chat/compaction/).
 *
 * Stateful A2A callers (chatops server-side sessions, the A2A v2 route) load
 * a context's full message history on every turn. Without a persisted
 * compaction, the per-step guard would re-summarize the same overflow on
 * every single turn and the caller would never learn about it. This module:
 * - applies the latest stored summary when loading history (summary message +
 *   messages after the boundary), and
 * - when the resulting history still crosses the shared threshold of the
 *   agent model's context window, summarizes the older prefix once via the
 *   shared compaction primitives, persists it, and reports the event so the
 *   caller can tell the user (e.g. a Telegram notice).
 *
 * Failures are non-fatal: the view with the stored summary applied is
 * returned and the per-step guard (agents/step-context-guard.ts) remains the
 * in-run safety net.
 */
import { CONTEXT_COMPACTION_AUTO_THRESHOLD } from "@archestra/shared";
import type { UIMessage } from "ai";
import logger from "@/logging";
import { A2AContextCompactionModel, ModelModel } from "@/models";
import { TOKEN_ESTIMATE } from "@/routes/chat/normalization/estimate-message-tokens";
import { resolveCompactionLlm } from "@/services/compaction-llm";
import {
  CONTEXT_COMPACTION_RECENT_KEEP_RATIO,
  type CompactionSummarizer,
  chooseRecentSuffixStart,
  compactionSummaryText,
  createCompactionSummarizer,
  renderCompactionTranscript,
  type TranscriptEntry,
  uiMessageTranscriptEntries,
} from "@/services/context-compaction";
import type { A2AMessage } from "@/types";
import { resolveAgentLlmOrDefault } from "@/utils/llm-resolution";

export interface A2AContextCompactionEvent {
  compactionId: string;
  originalTokenEstimate: number;
  compactedTokenEstimate: number;
}

/**
 * Apply the latest persisted compaction to a context's loaded history and,
 * when the result still exceeds the auto-compaction threshold of the agent
 * model's context window, create a new compaction.
 *
 * Returns the (possibly compacted) history view — synthetic summary messages
 * only ever live in the returned view, never in the `a2a_message` table —
 * plus the created compaction event, when one happened this call.
 *
 * `summarizeTranscript` is the LLM boundary, injectable for tests.
 */
export async function applyA2AContextCompaction(params: {
  contextId: string;
  messages: A2AMessage[];
  agent: {
    id: string;
    llmApiKeyId: string | null;
    modelId: string | null;
    organizationId: string;
  };
  userId: string | null;
  sessionId?: string;
  abortSignal?: AbortSignal;
  summarizeTranscript?: CompactionSummarizer;
}): Promise<{
  messages: A2AMessage[];
  created: A2AContextCompactionEvent | null;
}> {
  const { contextId, messages, agent, userId, sessionId, abortSignal } = params;
  // A failure past this point keeps whatever stored summary was applied:
  // dropping it would resend the overflow it already solved.
  let applied: AppliedCompaction = {
    view: messages,
    realMessages: messages,
    summary: null,
  };

  try {
    const latest =
      await A2AContextCompactionModel.findLatestByContext(contextId);
    applied = applyLatestCompaction(messages, latest);

    // The agent's own model defines the budget; without a known context
    // window there is no threshold to compact against (same policy as chat).
    const agentLlm = await resolveAgentLlmOrDefault({
      agent,
      organizationId: agent.organizationId,
      userId: userId ?? undefined,
    });
    const modelRow = await ModelModel.findByProviderAndModelId(
      agentLlm.provider,
      agentLlm.modelName,
    ).catch(() => null);
    // The window the turn actually runs with, not the architectural ceiling:
    // for Ollama an admin-pinned `num_ctx` is what Archestra sends on every
    // request, so compacting against the ceiling would never fire while Ollama
    // silently truncated the prompt.
    const effectiveContextLength = modelRow
      ? ModelModel.resolveEffectiveContextLength(modelRow)
      : null;
    if (!effectiveContextLength) {
      return { messages: applied.view, created: null };
    }

    const budgetTokens = Math.floor(
      effectiveContextLength * CONTEXT_COMPACTION_AUTO_THRESHOLD,
    );
    const originalTokenEstimate = estimateMessagesTokens(applied.view);
    if (originalTokenEstimate < budgetTokens) {
      return { messages: applied.view, created: null };
    }

    // Only real rows after the previous boundary are compactable; the recent
    // suffix stays verbatim so the model keeps the immediate back-and-forth.
    const split = splitForCompaction(applied.realMessages, budgetTokens);
    const boundaryMessage = split.compactable.at(-1);
    if (!boundaryMessage) {
      return { messages: applied.view, created: null };
    }

    const summarize =
      params.summarizeTranscript ??
      (await buildSummarizer({
        agent,
        userId,
        sessionId,
        abortSignal,
      }));
    if (!summarize) {
      return { messages: applied.view, created: null };
    }

    const summary = await summarize({
      transcript: renderCompactionTranscript(
        split.compactable.flatMap(transcriptEntries),
      ),
      previousSummary: applied.summary,
    });
    if (!summary) {
      logger.warn(
        { contextId },
        "[A2AContextCompaction] summarization produced no summary",
      );
      return { messages: applied.view, created: null };
    }

    const summaryMessage = buildSummaryMessage({ contextId, summary });
    const compactedView = [summaryMessage, ...split.recent];
    const compactedTokenEstimate = estimateMessagesTokens(compactedView);
    if (compactedTokenEstimate >= originalTokenEstimate) {
      logger.info(
        { contextId, originalTokenEstimate, compactedTokenEstimate },
        "[A2AContextCompaction] skipping non-beneficial compaction",
      );
      return { messages: applied.view, created: null };
    }

    const record = await A2AContextCompactionModel.create({
      contextId,
      summary,
      boundaryMessageId: boundaryMessage.id,
      provider: agentLlm.provider,
      model: agentLlm.modelName,
      originalTokenEstimate,
      compactedTokenEstimate,
    });

    logger.info(
      {
        contextId,
        compactionId: record.id,
        originalTokenEstimate,
        compactedTokenEstimate,
      },
      "[A2AContextCompaction] compacted context history",
    );

    return {
      messages: compactedView,
      created: {
        compactionId: record.id,
        originalTokenEstimate,
        compactedTokenEstimate,
      },
    };
  } catch (error) {
    if (!abortSignal?.aborted) {
      logger.warn(
        { error, contextId },
        "[A2AContextCompaction] failed to compact context history",
      );
    }
    return { messages: applied.view, created: null };
  }
}

// =============================================================================
// Internal Helpers
// =============================================================================

type AppliedCompaction = {
  view: A2AMessage[];
  realMessages: A2AMessage[];
  /** Summary covering the messages before `realMessages`, if one applied. */
  summary: string | null;
};

/**
 * Replace the prefix covered by the latest compaction with its summary
 * message. A stale boundary (message no longer in the list) makes the
 * compaction unusable — ignore it rather than lose history.
 */
function applyLatestCompaction(
  messages: A2AMessage[],
  latest: { summary: string; boundaryMessageId: string } | null,
): AppliedCompaction {
  const boundaryIndex = latest
    ? messages.findIndex((message) => message.id === latest.boundaryMessageId)
    : -1;
  if (!latest || boundaryIndex < 0) {
    return { view: messages, realMessages: messages, summary: null };
  }

  const realMessages = messages.slice(boundaryIndex + 1);
  const summaryMessage = buildSummaryMessage({
    contextId: messages[boundaryIndex].contextId,
    summary: latest.summary,
  });
  return {
    view: [summaryMessage, ...realMessages],
    realMessages,
    summary: latest.summary,
  };
}

/**
 * Synthetic history row carrying a compaction summary. Never persisted —
 * downstream consumers only read `content`, so the row shape just satisfies
 * the A2AMessage type.
 */
function buildSummaryMessage(params: {
  contextId: string;
  summary: string;
}): A2AMessage {
  const content: UIMessage = {
    id: `a2a-context-compaction-${params.contextId}`,
    role: "user",
    parts: [{ type: "text", text: compactionSummaryText(params.summary) }],
  };
  const now = new Date();
  return {
    id: `a2a-context-compaction-${params.contextId}`,
    contextId: params.contextId,
    taskId: null,
    role: "user",
    parts: [],
    content,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Keep a recent suffix of roughly the keep ratio of the budget verbatim
 * (always at least the most recent message); everything before it becomes
 * the compactable prefix.
 */
function splitForCompaction(
  messages: A2AMessage[],
  budgetTokens: number,
): { compactable: A2AMessage[]; recent: A2AMessage[] } {
  const boundary = chooseRecentSuffixStart({
    count: messages.length,
    sizeOf: (index) => estimateMessagesTokens([messages[index]]),
    keepBudget: budgetTokens * CONTEXT_COMPACTION_RECENT_KEEP_RATIO,
  });
  return {
    compactable: messages.slice(0, boundary),
    recent: messages.slice(boundary),
  };
}

/** Rough char-based token estimate, same yardstick as the per-step guard. */
function estimateMessagesTokens(messages: A2AMessage[]): number {
  const chars = messages.reduce(
    (sum, message) => sum + JSON.stringify(message.content ?? "").length,
    0,
  );
  return Math.ceil(chars / TOKEN_ESTIMATE.charsPerToken);
}

function transcriptEntries(message: A2AMessage): TranscriptEntry[] {
  const ui = message.content as UIMessage | undefined;
  return uiMessageTranscriptEntries({
    role: ui?.role ?? message.role,
    parts: ui?.parts ?? [],
  });
}

/**
 * Resolve the built-in compaction agent's model into a summarizer, or null
 * when no usable LLM is configured (compaction is then skipped).
 */
async function buildSummarizer(params: {
  agent: {
    id: string;
    llmApiKeyId: string | null;
    modelId: string | null;
    organizationId: string;
  };
  userId: string | null;
  sessionId?: string;
  abortSignal?: AbortSignal;
}): Promise<CompactionSummarizer | null> {
  const compactionLlm = await resolveCompactionLlm({
    organizationId: params.agent.organizationId,
    userId: params.userId ?? undefined,
    // The threshold above is computed from the calling agent's context
    // window, so the summary is written by that same model unless pinned.
    inheritFrom: {
      modelId: params.agent.modelId,
      agentLlmApiKeyId: params.agent.llmApiKeyId,
    },
    fallbackAgentId: params.agent.id,
    sessionId: params.sessionId,
    source: "a2a:compaction",
  });
  if (!compactionLlm) {
    logger.warn(
      { organizationId: params.agent.organizationId },
      "[A2AContextCompaction] no API key for compaction model; skipping",
    );
    return null;
  }

  // Last-resort flow (no interactive retry affordance): salvage untagged
  // output rather than fail the compaction, like chat's fallback path.
  return createCompactionSummarizer({
    model: compactionLlm.model,
    systemPrompt: compactionLlm.systemPrompt,
    abortSignal: params.abortSignal,
    salvageUntagged: true,
  });
}
