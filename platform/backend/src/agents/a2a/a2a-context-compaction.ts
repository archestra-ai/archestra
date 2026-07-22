/**
 * Persisted cross-turn compaction for stateful A2A contexts, mirroring web
 * chat's `conversation_compactions` flow (routes/chat/context-compaction.ts).
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
 * Failures are non-fatal: the uncompacted view is returned and the per-step
 * guard (agents/step-context-guard.ts) remains the in-run safety net.
 */
import { BUILT_IN_AGENT_IDS } from "@archestra/shared";
import type { UIMessage } from "ai";
import { createLLMModel, isApiKeyRequired } from "@/clients/llm-client";
import logger from "@/logging";
import { A2AContextCompactionModel, AgentModel, ModelModel } from "@/models";
import { TOKEN_ESTIMATE } from "@/routes/chat/normalization/estimate-message-tokens";
import {
  CONTEXT_COMPACTION_AUTO_THRESHOLD,
  CONTEXT_COMPACTION_TRANSCRIPT_MAX_CHARS,
  compactionSummaryText,
  composeCompactionPrompt,
  summarizeCompactionTranscript,
} from "@/services/context-compaction";
import type { A2AMessage } from "@/types";
import { resolveAgentLlmOrDefault } from "@/utils/llm-resolution";

export interface A2AContextCompactionEvent {
  compactionId: string;
  originalTokenEstimate: number;
  compactedTokenEstimate: number;
}

interface SummarizeParams {
  transcript: string;
  previousSummary: string | null;
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
  summarizeTranscript?: (params: SummarizeParams) => Promise<string | null>;
}): Promise<{
  messages: A2AMessage[];
  created: A2AContextCompactionEvent | null;
}> {
  const { contextId, messages, agent, userId, sessionId, abortSignal } = params;

  try {
    const latest =
      await A2AContextCompactionModel.findLatestByContext(contextId);
    const applied = applyLatestCompaction(messages, latest);

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
    if (!modelRow?.contextLength) {
      return { messages: applied.view, created: null };
    }

    const budgetTokens = Math.floor(
      modelRow.contextLength * CONTEXT_COMPACTION_AUTO_THRESHOLD,
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
      transcript: serializeForTranscript(split.compactable),
      previousSummary: latest?.summary ?? null,
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
    if (abortSignal?.aborted) {
      return { messages, created: null };
    }
    logger.warn(
      { error, contextId },
      "[A2AContextCompaction] failed to compact context history",
    );
    return { messages, created: null };
  }
}

// =============================================================================
// Internal Helpers
// =============================================================================

/**
 * Replace the prefix covered by the latest compaction with its summary
 * message. A stale boundary (message no longer in the list) makes the
 * compaction unusable — ignore it rather than lose history.
 */
function applyLatestCompaction(
  messages: A2AMessage[],
  latest: { id: string; summary: string; boundaryMessageId: string } | null,
): { view: A2AMessage[]; realMessages: A2AMessage[] } {
  if (!latest) {
    return { view: messages, realMessages: messages };
  }

  const boundaryIndex = messages.findIndex(
    (message) => message.id === latest.boundaryMessageId,
  );
  if (boundaryIndex < 0) {
    return { view: messages, realMessages: messages };
  }

  const realMessages = messages.slice(boundaryIndex + 1);
  const summaryMessage = buildSummaryMessage({
    contextId: messages[boundaryIndex].contextId,
    summary: latest.summary,
  });
  return { view: [summaryMessage, ...realMessages], realMessages };
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
 * Keep a recent suffix of roughly RECENT_KEEP_RATIO of the budget verbatim
 * (always at least the most recent message); everything before it becomes
 * the compactable prefix.
 */
function splitForCompaction(
  messages: A2AMessage[],
  budgetTokens: number,
): { compactable: A2AMessage[]; recent: A2AMessage[] } {
  if (messages.length <= 1) {
    return { compactable: [], recent: messages };
  }

  const keepTokens = budgetTokens * RECENT_KEEP_RATIO;
  let boundary = messages.length - 1;
  let kept = estimateMessagesTokens([messages[boundary]]);
  while (boundary > 0) {
    const next = estimateMessagesTokens([messages[boundary - 1]]);
    if (kept + next > keepTokens) break;
    kept += next;
    boundary--;
  }

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

/**
 * Render persisted UIMessages as a plain-text transcript for the summarizer,
 * covering text, tool, and file parts (same shapes the step guard serializes).
 */
function serializeForTranscript(messages: A2AMessage[]): string {
  const lines: string[] = [];
  for (const message of messages) {
    const ui = message.content as UIMessage | undefined;
    const role = ui?.role ?? message.role;
    for (const part of ui?.parts ?? []) {
      const record = part as unknown as Record<string, unknown>;
      const type = String(record.type ?? "");
      if (type === "text") {
        lines.push(`[${role}]: ${String(record.text ?? "")}`);
      } else if (type === "file") {
        lines.push(`[${role} attached a file]`);
      } else if (type.startsWith("tool-") || type === "dynamic-tool") {
        const toolName =
          type === "dynamic-tool"
            ? String(record.toolName ?? "tool")
            : type.slice("tool-".length);
        lines.push(
          `[assistant → tool ${toolName}]: ${truncate(
            safeJson(record.input),
            TRANSCRIPT_TOOL_INPUT_MAX_CHARS,
          )}`,
        );
        if (record.output !== undefined) {
          lines.push(
            `[tool ${toolName} result]: ${truncate(
              safeJson(record.output),
              TRANSCRIPT_TOOL_RESULT_MAX_CHARS,
            )}`,
          );
        }
      }
    }
  }
  const transcript = lines.join("\n");
  // keep the tail — recent context matters most for continuing the thread
  return transcript.length <= CONTEXT_COMPACTION_TRANSCRIPT_MAX_CHARS
    ? transcript
    : transcript.slice(
        transcript.length - CONTEXT_COMPACTION_TRANSCRIPT_MAX_CHARS,
      );
}

/**
 * Resolve the built-in compaction agent's model into a summarize function,
 * or null when no usable LLM is configured (compaction is then skipped).
 */
async function buildSummarizer(params: {
  agent: {
    id: string;
    organizationId: string;
  };
  userId: string | null;
  sessionId?: string;
  abortSignal?: AbortSignal;
}): Promise<((params: SummarizeParams) => Promise<string | null>) | null> {
  const compactionAgent = await AgentModel.getBuiltInAgent(
    BUILT_IN_AGENT_IDS.CONTEXT_COMPACTION,
    params.agent.organizationId,
  );
  const compactionLlm = await resolveAgentLlmOrDefault({
    agent: compactionAgent,
    organizationId: params.agent.organizationId,
    userId: params.userId ?? undefined,
  });
  if (isApiKeyRequired(compactionLlm.provider, compactionLlm.apiKey)) {
    logger.warn(
      { organizationId: params.agent.organizationId },
      "[A2AContextCompaction] no API key for compaction model; skipping",
    );
    return null;
  }

  const model = createLLMModel({
    provider: compactionLlm.provider,
    apiKey: compactionLlm.apiKey,
    agentId: compactionAgent?.id ?? params.agent.id,
    modelName: compactionLlm.modelName,
    baseUrl: compactionLlm.baseUrl,
    userId: params.userId ?? undefined,
    sessionId: params.sessionId,
    source: "a2a:compaction",
  });

  // Last-resort flow (no interactive retry affordance): salvage untagged
  // output rather than fail the compaction, like chat's fallback path.
  return (summarizeParams: SummarizeParams) =>
    summarizeCompactionTranscript({
      model,
      prompt: composeCompactionPrompt({
        previousSummary: summarizeParams.previousSummary,
        transcript: summarizeParams.transcript,
      }),
      abortSignal: params.abortSignal,
      salvageUntagged: true,
    });
}

function truncate(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}…`;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/** Share of the token budget preserved verbatim as the recent suffix. */
const RECENT_KEEP_RATIO = 0.3;

// Per-entry caps for the transcript serializer (the whole-transcript ceiling
// is the shared CONTEXT_COMPACTION_TRANSCRIPT_MAX_CHARS).
const TRANSCRIPT_TOOL_INPUT_MAX_CHARS = 2_000;
const TRANSCRIPT_TOOL_RESULT_MAX_CHARS = 8_000;
