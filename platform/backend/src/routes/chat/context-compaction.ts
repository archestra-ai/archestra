/**
 * Context compaction for long-running agent sessions.
 *
 * When a conversation's message history grows large enough to approach the model's
 * context window, older messages are summarized and stored as a compaction record.
 * On the next request the summary is re-injected as a system message so the agent
 * retains continuity without replaying the full history.
 *
 * Design decisions:
 * - Compaction is triggered BEFORE sending messages to the LLM, using a character-count
 *   heuristic (CHARS_PER_TOKEN * COMPACTION_THRESHOLD_TOKENS).
 * - Only messages beyond a minimum history window are compacted; the N most recent
 *   exchanges are always kept verbatim so the model has fresh context.
 * - Summaries are generated using the same provider/model as the conversation so we
 *   don't need a separate LLM key or provider.
 * - The summary is stored in the `conversation_compactions` table and prepended as a
 *   synthetic system message when the compacted messages are dropped.
 */
import type { SupportedProvider } from "@shared";
import { generateText, type ModelMessage } from "ai";
import { createDirectLLMModel } from "@/clients/llm-client";
import logger from "@/logging";
import { ConversationCompactionModel } from "@/models";
import { resolveFastModelName } from "@/utils/llm-resolution";
import { resolveProviderApiKey } from "@/utils/llm-api-key-resolution";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CHARS_PER_TOKEN = 4;

/**
 * Token threshold above which we attempt compaction.
 * 80 k tokens × 4 chars/token ≈ 320 000 characters.
 * Adjust via ARCHESTRA_CHAT_COMPACTION_THRESHOLD_TOKENS if needed.
 */
const COMPACTION_THRESHOLD_TOKENS = 80_000;

/**
 * Number of most-recent non-system messages to keep verbatim after compaction.
 * Must be at least 2 (last user turn + last assistant turn).
 */
const RECENT_MESSAGES_TO_KEEP = 10;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface CompactionResult {
  /** Messages to send to the LLM (compacted + recent). */
  messages: ModelMessage[];
  /** Whether compaction was actually performed this call. */
  compacted: boolean;
  /** Human-readable summary written to the DB (or null when not compacted). */
  summary: string | null;
}

/**
 * Determines whether the message list is large enough to warrant compaction.
 */
export function shouldCompact(messages: ModelMessage[]): boolean {
  const totalChars = messages.reduce(
    (sum, m) => sum + JSON.stringify(m.content).length,
    0,
  );
  return totalChars > COMPACTION_THRESHOLD_TOKENS * CHARS_PER_TOKEN;
}

/**
 * Applies context compaction to `messages` if they exceed the threshold.
 *
 * Steps:
 * 1. Check whether the total char count exceeds the threshold.
 * 2. If a prior compaction summary exists for this conversation, prepend it to
 *    the messages that will be summarised (so the new summary is cumulative).
 * 3. Call the LLM to summarise the "old" portion of the conversation.
 * 4. Persist the compaction record.
 * 5. Return the compacted message list: [system notice + summary] + recent messages.
 *
 * When compaction is not needed the original messages are returned unchanged.
 */
export async function compactMessagesIfNeeded(params: {
  messages: ModelMessage[];
  conversationId: string;
  provider: SupportedProvider;
  organizationId: string;
  userId: string;
  chatApiKeyId?: string;
}): Promise<CompactionResult> {
  const { messages, conversationId, provider, organizationId, userId, chatApiKeyId } =
    params;

  if (!shouldCompact(messages)) {
    return { messages, compacted: false, summary: null };
  }

  const systemMessages = messages.filter((m) => m.role === "system");
  const nonSystemMessages = messages.filter((m) => m.role !== "system");

  // Keep the most recent exchanges verbatim.
  const keepCount = Math.min(RECENT_MESSAGES_TO_KEEP, nonSystemMessages.length);
  const toCompact = nonSystemMessages.slice(0, nonSystemMessages.length - keepCount);
  const toKeep = nonSystemMessages.slice(nonSystemMessages.length - keepCount);

  if (toCompact.length === 0) {
    // Nothing old enough to compact.
    return { messages, compacted: false, summary: null };
  }

  // Load the latest previous summary so our new summary is cumulative.
  const previousCompaction =
    await ConversationCompactionModel.findLatestByConversation(conversationId);

  let summary: string | null = null;

  try {
    summary = await generateSummary({
      messagesToSummarize: toCompact,
      previousSummary: previousCompaction?.summary ?? null,
      provider,
      organizationId,
      userId,
      chatApiKeyId,
    });
  } catch (error) {
    logger.warn(
      { error, conversationId },
      "[ContextCompaction] Summary generation failed; skipping compaction for this turn",
    );
    return { messages, compacted: false, summary: null };
  }

  // Persist the compaction record.
  const compactedMessageIds = toCompact
    .map((m) => {
      // ModelMessage does not carry an id; we extract it from content if present.
      const content = m.content;
      if (typeof content === "object" && content !== null && "id" in content) {
        return String((content as Record<string, unknown>).id);
      }
      return null;
    })
    .filter((id): id is string => id !== null);

  await ConversationCompactionModel.create({
    conversationId,
    compactedMessageCount: toCompact.length,
    summary,
    compactedMessageIds,
  }).catch((err) => {
    logger.error(
      { err, conversationId },
      "[ContextCompaction] Failed to persist compaction record",
    );
  });

  logger.info(
    {
      conversationId,
      compactedCount: toCompact.length,
      keptCount: toKeep.length,
      summaryLength: summary.length,
    },
    "[ContextCompaction] Compacted conversation history",
  );

  // Build the replacement message list:
  // system messages (original) + compaction notice + recent non-system messages.
  const compactionNotice: ModelMessage = {
    role: "system",
    content: buildCompactionNotice(summary),
  };

  const compactedMessages: ModelMessage[] = [
    ...systemMessages,
    compactionNotice,
    ...toKeep,
  ];

  return { messages: compactedMessages, compacted: true, summary };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function buildCompactionNotice(summary: string): string {
  return (
    "[Context compaction — earlier conversation history has been summarized to fit within the context window.]\n\n" +
    `Summary of earlier conversation:\n${summary}`
  );
}

async function generateSummary(params: {
  messagesToSummarize: ModelMessage[];
  previousSummary: string | null;
  provider: SupportedProvider;
  organizationId: string;
  userId: string;
  chatApiKeyId?: string;
}): Promise<string> {
  const { messagesToSummarize, previousSummary, provider, organizationId, userId, chatApiKeyId } =
    params;

  const { apiKey, baseUrl } = await resolveProviderApiKey({
    organizationId,
    userId,
    provider,
  });

  const modelName = await resolveFastModelName(provider, chatApiKeyId);
  const model = createDirectLLMModel({ provider, apiKey, modelName, baseUrl });

  const prompt = buildSummaryPrompt(messagesToSummarize, previousSummary);

  const result = await generateText({ model, prompt });
  return result.text.trim();
}

function buildSummaryPrompt(
  messages: ModelMessage[],
  previousSummary: string | null,
): string {
  const lines: string[] = [];

  if (previousSummary) {
    lines.push("Previous summary of even earlier context:");
    lines.push(previousSummary);
    lines.push("");
    lines.push(
      "Extend or refine the summary above to incorporate the following additional messages:",
    );
  } else {
    lines.push(
      "Summarize the following conversation messages concisely. " +
        "Capture key decisions, facts, requirements, and outcomes discussed. " +
        "Preserve enough detail that an AI assistant can continue the conversation without losing important context. " +
        "Focus on what the user asked, what the assistant found or did, and any important outcomes. " +
        "Output only the summary — no preamble, no markdown headings.",
    );
  }

  lines.push("");

  for (const msg of messages) {
    const role = msg.role === "assistant" ? "Assistant" : capitalize(msg.role);
    const text =
      typeof msg.content === "string"
        ? msg.content
        : JSON.stringify(msg.content);
    lines.push(`${role}: ${text}`);
  }

  return lines.join("\n");
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
