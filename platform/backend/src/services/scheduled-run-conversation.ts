import {
  ChatErrorCode,
  type ChatErrorResponse,
  DynamicInteraction,
  type PartialUIMessage,
} from "@archestra/shared";
import type { UIMessage } from "ai";
import {
  AgentModel,
  ConversationChatErrorModel,
  ConversationModel,
  InteractionModel,
  MessageModel,
  ScheduleTriggerRunModel,
} from "@/models";
import type {
  Conversation,
  ScheduleTrigger,
  ScheduleTriggerRun,
} from "@/types";
import { resolveConversationLlmSelectionForAgent } from "@/utils/llm-resolution";
import {
  stripThinkingBlocks,
  THINKING_ONLY_NOTICE,
} from "@/utils/strip-thinking-blocks";

/**
 * Shared helpers for the chat conversation backing a scheduled trigger run.
 *
 * Two callers materialize this conversation:
 *   - the run handler, BEFORE execution, for project-scoped triggers — so the
 *     run executes against a real conversation whose `project_id` lets the file
 *     tools resolve project scope (save_file etc. land in the project).
 *   - the run-view route, AFTER execution, to show the run as a chat.
 *
 * Creation is centralized here and linked with a compare-and-swap so the two
 * paths can never create two conversations for one run.
 *
 * Messages are written by one of two paths, both idempotent (no-op once the
 * conversation has messages):
 *   - PRIMARY (`persistRunConversationMessages`): the run handler, at completion,
 *     stores `[user, responseUiMessage]` from the executor's in-memory result —
 *     race-free, since it never reads the run's `interactions` rows.
 *   - FALLBACK (`backfillRunConversationMessages`): the view path reconstructs
 *     the transcript from the run's interactions. Used for unscoped runs (no
 *     up-front conversation) and as a safety net; safe by view time because all
 *     interactions have committed. Must NOT run at creation time (no interactions
 *     yet) — only once they exist.
 */

/** A short title seeded from the trigger's message template. */
function buildRunConversationSeedTitle(prompt: string): string {
  const normalizedPrompt = prompt.trim().replace(/\s+/g, " ");
  if (!normalizedPrompt) {
    return "Scheduled run";
  }
  return normalizedPrompt.length > 72
    ? `${normalizedPrompt.slice(0, 69).trimEnd()}...`
    : normalizedPrompt;
}

/**
 * Create the run's chat conversation and link it to the run (CAS on a null
 * `chat_conversation_id`). If another path linked first, the just-created
 * conversation is dropped and the winner's conversation is returned, so a run
 * never ends up with two conversations.
 */
export async function createAndLinkRunConversation(params: {
  run: ScheduleTriggerRun;
  trigger: ScheduleTrigger;
  /** Conversation owner: the actor (execution path) or requester (view path). */
  ownerUserId: string;
  organizationId: string;
}): Promise<Conversation> {
  const { run, trigger, ownerUserId, organizationId } = params;
  const agent = await AgentModel.findById(trigger.agentId);
  if (!agent || agent.organizationId !== organizationId) {
    throw new Error("The agent used for this run no longer exists");
  }

  const llmSelection = await resolveConversationLlmSelectionForAgent({
    agent: {
      llmApiKeyId: agent.llmApiKeyId ?? null,
      modelId: agent.modelId ?? null,
    },
    organizationId,
    userId: ownerUserId,
  });

  const created = await ConversationModel.create({
    userId: ownerUserId,
    organizationId,
    agentId: trigger.agentId,
    title: buildRunConversationSeedTitle(trigger.messageTemplate),
    modelId: llmSelection.modelId,
    chatApiKeyId: llmSelection.chatApiKeyId,
    artifact: run.artifact ?? undefined,
    projectId: trigger.projectId ?? null,
    origin: "schedule_trigger",
  });

  const won = await ScheduleTriggerRunModel.setChatConversationId(
    run.id,
    created.id,
  );
  if (won) {
    return created;
  }

  // Lost the race: another path linked first. Drop our orphan and return theirs.
  await ConversationModel.delete(created.id, ownerUserId, organizationId);
  const fresh = await ScheduleTriggerRunModel.findById(run.id);
  const existing = fresh?.chatConversationId
    ? await ConversationModel.findByIdInOrganization({
        id: fresh.chatConversationId,
        organizationId,
      })
    : null;
  if (!existing) {
    throw new Error("Failed to resolve the run conversation");
  }
  return existing;
}

/**
 * Persist a scheduled run's chat transcript from the executor's own result —
 * the user prompt plus the complete assistant turn (`responseUiMessage`, which
 * already holds every tool-call, tool-result, and the final answer text). This
 * is race-free: it does not read the `interactions` rows, which the LLM proxy
 * commits in a `finally` after the stream is flushed and so are not reliably
 * visible at run completion. Idempotent — a no-op once the conversation has any
 * messages, so the lazy view-path stays a safe fallback.
 */
export async function persistRunConversationMessages(params: {
  conversation: Conversation;
  userText: string;
  assistantMessage: UIMessage;
}): Promise<void> {
  const { conversation, userText, assistantMessage } = params;

  if (await MessageModel.existsForConversation(conversation.id)) {
    return;
  }

  // Distinct timestamps so the transcript renders user-before-assistant
  // (messages are ordered by createdAt). Built as a variable, not an inline
  // literal, so the createdAt passthrough type-checks (matches backfill below).
  const createdAt = Date.now();
  const rows = [
    {
      conversationId: conversation.id,
      role: "user",
      content: { role: "user", parts: [{ type: "text", text: userText }] },
      createdAt: new Date(createdAt),
    },
    {
      conversationId: conversation.id,
      role: assistantMessage.role,
      content: assistantMessage,
      createdAt: new Date(createdAt + 1),
    },
  ];
  await MessageModel.bulkCreate(rows);
}

/**
 * Persist the scheduled prompt as the run conversation's user message so a failed
 * run's chat carries it: the inline error card renders beneath the prompt and the
 * scheduled-run "Try again" can resend it. Idempotent — a no-op once the
 * conversation has any message, so it never duplicates the prompt the success
 * path (`persistRunConversationMessages`) writes, nor double-seeds on a retry.
 */
export async function persistRunUserMessage(params: {
  conversation: Conversation;
  userText: string;
}): Promise<void> {
  const { conversation, userText } = params;

  if (await MessageModel.existsForConversation(conversation.id)) {
    return;
  }

  // Single message, so no createdAt ordering to control (defaults at insert).
  await MessageModel.bulkCreate([
    {
      conversationId: conversation.id,
      role: "user",
      content: { role: "user", parts: [{ type: "text", text: userText }] },
    },
  ]);
}

/**
 * Record a failed run's error on its (kept) conversation as a chat error, so the
 * run's chat renders it as an inline error card — a failed run opens a normal
 * chat showing what went wrong, rather than a blank transcript. The error is the
 * provider's structured `ChatErrorResponse` (same one the interactive chat uses),
 * so the card keeps its proper code and retry affordances.
 */
export async function recordRunConversationError(params: {
  conversationId: string;
  error: ChatErrorResponse;
}): Promise<void> {
  await ConversationChatErrorModel.create({
    conversationId: params.conversationId,
    error: params.error,
  });
}

/**
 * Make a FAILED run's conversation show what went wrong even when the run never
 * reached the execute path that records a chat error — a skip ("previous run
 * still in progress") or a pre-execution failure (e.g. lost agent access) is
 * marked failed before any conversation, transcript, or error exists. Without
 * this, opening such a run lazily-creates a blank chat. Persist the prompt as the
 * user message and record the run's `error` as a chat error, so the chat shows
 * the prompt + an inline error card (and the scheduled-run "Try again").
 *
 * Idempotent and non-destructive: a no-op once the conversation has any message
 * or chat error, so it never overwrites a real transcript or a richer structured
 * error already recorded by the run handler on an execution failure.
 */
export async function ensureFailedRunErrorVisible(params: {
  conversation: Conversation;
  run: ScheduleTriggerRun;
  trigger: ScheduleTrigger;
}): Promise<void> {
  const { conversation, run, trigger } = params;
  if (run.status !== "failed") {
    return;
  }

  const [hasMessages, errors] = await Promise.all([
    MessageModel.existsForConversation(conversation.id),
    ConversationChatErrorModel.findByConversation(conversation.id),
  ]);
  if (hasMessages || errors.length > 0) {
    return;
  }

  await persistRunUserMessage({
    conversation,
    userText: trigger.messageTemplate,
  });
  await recordRunConversationError({
    conversationId: conversation.id,
    error: {
      code: ChatErrorCode.Unknown,
      message:
        run.error ??
        "This scheduled run failed before it could produce a response.",
      isRetryable: false,
    },
  });
}

/**
 * Backfill chat messages from the run's interactions when the conversation has
 * none yet. No-op until interactions exist, so it is safe to call repeatedly
 * (and must NOT be called before execution, or it would seed placeholders).
 */
export async function backfillRunConversationMessages(params: {
  conversation: Conversation;
  trigger: ScheduleTrigger;
  run: ScheduleTriggerRun;
  ownerUserId: string;
}): Promise<void> {
  const { conversation, trigger, run, ownerUserId } = params;
  const existing = await MessageModel.findByConversation(conversation.id);
  if (existing.length > 0) {
    return;
  }

  // Only interactions[0] is consumed below — the newest interaction carries the
  // full history in its request and the final reply in its response.
  const interactionResult = await InteractionModel.findAllPaginated(
    { limit: 1, offset: 0 },
    { sortBy: "createdAt", sortDirection: "desc" },
    ownerUserId,
    true,
    { profileId: trigger.agentId, sessionId: `scheduled-${run.id}` },
  );
  const uiMessages = buildMessagesFromInteractions(
    interactionResult.data,
    trigger.messageTemplate,
  );
  if (uiMessages.length === 0) {
    return;
  }

  const createdAt = Date.now();
  await MessageModel.bulkCreate(
    uiMessages.map((message, index) => ({
      conversationId: conversation.id,
      role: message.role,
      content: message,
      createdAt: new Date(createdAt + index),
    })),
  );
}

// === internal ===

function buildMessagesFromInteractions(
  interactions: Array<{
    type: string;
    request: unknown;
    response: unknown;
    model?: string | null;
    dualLlmAnalyses?: unknown;
  }>,
  messageTemplate: string,
): PartialUIMessage[] {
  // No interactions yet (e.g. an in-flight run viewed early): return nothing so
  // the caller doesn't persist a placeholder transcript that would block the
  // real one from ever being reconstructed.
  if (interactions.length === 0) {
    return [];
  }

  // Interactions are fetched desc — the first is the most recent (last in the
  // agentic loop); its request holds the full history and its response the final
  // reply, so using only it avoids duplicate messages from replayed prefixes.
  const lastInteraction = interactions[0];
  const messages: PartialUIMessage[] = [];

  if (lastInteraction) {
    try {
      const di = new DynamicInteraction(lastInteraction as never);
      messages.push(...di.mapToUiMessages());
    } catch {
      // Skip if the interaction can't be parsed.
    }
  }

  if (messages.length > 0) {
    // Reconstructed from raw LLM-proxy interactions, which bypass the A2A
    // executor's sanitization, so strip inline `<thinking>` blocks here too.
    // These messages are freshly built above, so mutate text parts in place.
    // An assistant turn whose text was entirely `<thinking>` strips to nothing;
    // substitute the notice so it matches the live executor path rather than
    // rendering a blank bubble.
    for (const message of messages) {
      let hadText = false;
      let hasVisibleText = false;
      let noticeTarget: { text: string } | null = null;
      for (const part of message.parts) {
        if (part.type === "text" && typeof part.text === "string") {
          if (part.text.trim() !== "") {
            hadText = true;
          }
          part.text = stripThinkingBlocks(part.text);
          if (part.text !== "") {
            hasVisibleText = true;
          }
          noticeTarget ??= part;
        }
      }
      if (
        message.role === "assistant" &&
        hadText &&
        !hasVisibleText &&
        noticeTarget
      ) {
        noticeTarget.text = THINKING_ONLY_NOTICE;
      }
    }
    return messages;
  }

  return [
    { role: "user", parts: [{ type: "text", text: messageTemplate }] },
    {
      role: "assistant",
      parts: [
        {
          type: "text",
          text: "No output was captured for this scheduled run.",
        },
      ],
    },
  ];
}
