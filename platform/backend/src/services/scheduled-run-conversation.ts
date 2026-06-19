import { DynamicInteraction, type PartialUIMessage } from "@archestra/shared";
import {
  AgentModel,
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

/**
 * Shared helpers for the chat conversation backing a scheduled trigger run.
 *
 * Two callers materialize this conversation:
 *   - the run handler, BEFORE execution, for project-scoped triggers — so the
 *     run executes against a real conversation whose `project_id` lets the file
 *     tools resolve project scope (save_result etc. land in the project).
 *   - the run-view route, AFTER execution, to show the run as a chat.
 *
 * Creation is centralized here and linked with a compare-and-swap so the two
 * paths can never create two conversations for one run. Messages are
 * reconstructed from the run's interactions (the A2A executor persists
 * interactions, not chat messages), so backfilling is done by the view path
 * once interactions exist — never at creation time.
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

  const interactionResult = await InteractionModel.findAllPaginated(
    { limit: 50, offset: 0 },
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
