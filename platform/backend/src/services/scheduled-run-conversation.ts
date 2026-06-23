import { DynamicInteraction, type PartialUIMessage } from "@archestra/shared";
import {
  AgentModel,
  ConversationModel,
  InteractionModel,
  MessageModel,
  ScheduleTriggerModel,
} from "@/models";
import type {
  Conversation,
  ScheduleTrigger,
  ScheduleTriggerRun,
} from "@/types";
import { resolveConversationLlmSelectionForAgent } from "@/utils/llm-resolution";

/**
 * The chat conversation backing a scheduled trigger is shared by ALL of its
 * runs (cowork-style): one chat per schedule, not one per run. Each run executes
 * against this conversation and appends its own turn once it finishes, so the
 * chat grows into the schedule's full run history instead of spawning a new
 * (and empty, until viewed) conversation every time.
 *
 * Two callers materialize the conversation:
 *   - the run handler, BEFORE execution, for every run — so the run executes
 *     against a real conversation whose `project_id` (project triggers) or
 *     `conversation_id` (unscoped triggers) lets the file tools resolve scope.
 *   - the routes, to open the schedule's chat from the UI.
 *
 * Creation is centralized here and linked to the trigger with a compare-and-swap
 * so concurrent first runs can never create two conversations for one schedule.
 * Messages are reconstructed from a run's interactions (the A2A executor persists
 * interactions, not chat messages) and appended by the handler once the run
 * succeeds — never at creation time, when no interactions exist yet.
 */

/**
 * Return the schedule's single chat conversation, creating and linking it on
 * first use (CAS on the trigger's null `chat_conversation_id`). If another path
 * linked first, the just-created conversation is dropped and the winner's is
 * returned, so a schedule never ends up with two conversations.
 */
export async function ensureTriggerConversation(params: {
  trigger: ScheduleTrigger;
  /** Conversation owner: the trigger's actor (so its runs own their own chat). */
  ownerUserId: string;
  organizationId: string;
}): Promise<Conversation> {
  const { trigger, ownerUserId, organizationId } = params;

  // Fast path: already linked (the FK SET-NULLs the link if the conversation is
  // deleted, so a non-null id always resolves to a live conversation).
  if (trigger.chatConversationId) {
    const existing = await ConversationModel.findByIdInOrganization({
      id: trigger.chatConversationId,
      organizationId,
    });
    if (existing) {
      return existing;
    }
  }

  const agent = await AgentModel.findById(trigger.agentId);
  if (!agent || agent.organizationId !== organizationId) {
    throw new Error("The agent used for this schedule no longer exists");
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
    title: trigger.name,
    modelId: llmSelection.modelId,
    chatApiKeyId: llmSelection.chatApiKeyId,
    projectId: trigger.projectId ?? null,
    origin: "schedule_trigger",
  });

  const won = await ScheduleTriggerModel.setChatConversationId(
    trigger.id,
    created.id,
  );
  if (won) {
    return created;
  }

  // Lost the race: another path linked first. Drop our orphan and return theirs.
  await ConversationModel.delete(created.id, ownerUserId, organizationId);
  const fresh = await ScheduleTriggerModel.findById(trigger.id);
  const existing = fresh?.chatConversationId
    ? await ConversationModel.findByIdInOrganization({
        id: fresh.chatConversationId,
        organizationId,
      })
    : null;
  if (!existing) {
    throw new Error("Failed to resolve the schedule conversation");
  }
  return existing;
}

/**
 * Append a finished run's turn to the schedule's shared conversation.
 * Reconstructs the turn from the run's interactions; a no-op when the run
 * produced none, so it never seeds a placeholder transcript.
 *
 * The caller (run handler) runs this inside the SAME transaction that flips the
 * run to `success` (passing that transaction as `executor`), so message
 * persistence is atomic with the terminal-state CAS: exactly-once, never lost on
 * a crash between the two writes. Message `createdAt` is derived from the run's
 * `startedAt` so successive runs render in chronological order even if a slow
 * run appends after a later one.
 */
export async function appendRunMessagesToConversation(
  params: {
    conversation: Conversation;
    trigger: ScheduleTrigger;
    run: ScheduleTriggerRun;
  },
  executor?: Parameters<typeof MessageModel.bulkCreate>[1],
): Promise<void> {
  const { conversation, trigger, run } = params;

  const interactionResult = await InteractionModel.findAllPaginated(
    { limit: 50, offset: 0 },
    { sortBy: "createdAt", sortDirection: "desc" },
    conversation.userId,
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

  // Order successive runs chronologically by the run's own start time, not
  // wall-clock at append, so a slow run can't jump ahead of a later one.
  const base = (run.startedAt ?? run.createdAt).getTime();
  await MessageModel.bulkCreate(
    uiMessages.map((message, index) => ({
      conversationId: conversation.id,
      role: message.role,
      content: message,
      createdAt: new Date(base + index),
    })),
    executor,
  );
}

/**
 * Surface the latest run's artifact (if any) as the schedule conversation's
 * document. Idempotent (latest run wins), so it is safe to run outside the
 * message-append transaction.
 */
export async function syncRunArtifactToConversation(params: {
  conversation: Conversation;
  run: ScheduleTriggerRun;
  organizationId: string;
}): Promise<void> {
  const { conversation, run, organizationId } = params;
  if (!run.artifact || run.artifact === conversation.artifact) {
    return;
  }
  await ConversationModel.update(
    conversation.id,
    conversation.userId,
    organizationId,
    { artifact: run.artifact },
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
