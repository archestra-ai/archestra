/**
 * ChatOps ↔ chat-conversation bridge: persists ChatOps (Slack / MS Teams /
 * Telegram) threads into the canonical `conversations`/`messages` tables so
 * they can be continued on the web, and prepares the access-filtered history
 * a ChatOps turn feeds back to the model (which is how web turns become
 * visible to the next ChatOps turn).
 *
 * Modeled on services/scheduled-run-conversation.ts: the conversation is
 * created with the sender as owner and the agent's own LLM selection, then
 * CAS-linked to the thread via chatops_thread_conversations; a losing racer
 * drops its orphan conversation and adopts the winner's.
 */
import type { ChatErrorResponse } from "@archestra/shared";
import type { UIMessage } from "ai";
import logger from "@/logging";
import {
  AgentModel,
  ChatOpsThreadConversationModel,
  ConversationChatErrorModel,
  ConversationModel,
  MessageModel,
} from "@/models";
import { normalizeChatMessagesForPersistence } from "@/routes/chat/normalization/normalize-chat-messages";
import type { ChatMessage } from "@/types";
import type { ChatOpsProviderType } from "@/types/chatops";
import type { ChatOpsThreadConversation } from "@/types/chatops-thread-conversation";
import type { Conversation, ConversationOrigin } from "@/types/conversation";
import { resolveConversationLlmSelectionForAgent } from "@/utils/llm-resolution";

/** Per-message provenance recorded inside `content.metadata.chatops`. */
interface ChatOpsMessageMetadata {
  /** Interaction-source-style origin of the row, e.g. "chatops:slack". */
  source: ConversationOrigin;
  /** Provider-native message id — the ingestion idempotency key. */
  providerMessageId?: string;
  /** Display name of the human who authored the turn (multi-user threads). */
  authorName?: string;
  /** Platform user id of the author when the sender resolved to one. */
  authorUserId?: string;
  /**
   * Assistant rows only: whether the run that produced this turn saw the full
   * conversation history ("full", owner/DM turns) or only provider-tagged
   * rows ("provider"). Non-owner channel context excludes "full" rows so a
   * teammate can't surface the owner's web-side work in a shared channel.
   */
  contextScope?: "provider" | "full";
}

function chatOpsOrigin(provider: ChatOpsProviderType): ConversationOrigin {
  return CHATOPS_ORIGINS[provider];
}

/**
 * Find the persisted conversation for a ChatOps thread, or create one owned
 * by the invoking sender. Returns whether the sender owns the conversation
 * (drives the channel-leak context filter).
 */
export async function resolveOrCreateThreadConversation(params: {
  bindingId: string;
  organizationId: string;
  effectiveThreadId: string;
  provider: ChatOpsProviderType;
  senderUserId: string;
  agentId: string;
  seedTitle: string;
}): Promise<{
  mapping: ChatOpsThreadConversation;
  conversation: Conversation;
  senderIsOwner: boolean;
}> {
  const {
    bindingId,
    organizationId,
    effectiveThreadId,
    provider,
    senderUserId,
    agentId,
    seedTitle,
  } = params;

  const existing = await ChatOpsThreadConversationModel.findByBindingAndThread(
    bindingId,
    effectiveThreadId,
  );
  if (existing) {
    const conversation = await ConversationModel.findByIdInOrganization({
      id: existing.conversationId,
      organizationId,
    });
    if (!conversation) {
      // The FK cascade removes the mapping with its conversation, so a
      // dangling mapping means cross-org confusion or a mid-flight delete.
      throw new Error(
        "ChatOps thread conversation mapping points to a missing conversation",
      );
    }
    return {
      mapping: existing,
      conversation,
      senderIsOwner: conversation.userId === senderUserId,
    };
  }

  const agent = await AgentModel.findById(agentId);
  if (!agent || agent.organizationId !== organizationId) {
    throw new Error("The agent for this ChatOps thread no longer exists");
  }
  const llmSelection = await resolveConversationLlmSelectionForAgent({
    agent: {
      llmApiKeyId: agent.llmApiKeyId ?? null,
      modelId: agent.modelId ?? null,
    },
    organizationId,
    userId: senderUserId,
    // A ChatOps turn is not the owner driving the /chat model selector, so it
    // seeds from the agent's own configuration, not the owner's chat default.
    includeMemberChatDefault: false,
  });

  const created = await ConversationModel.create({
    userId: senderUserId,
    organizationId,
    agentId,
    title: buildSeedTitle(seedTitle),
    modelId: llmSelection.modelId,
    chatApiKeyId: llmSelection.chatApiKeyId,
    origin: chatOpsOrigin(provider),
  });

  let casResult: Awaited<
    ReturnType<typeof ChatOpsThreadConversationModel.createIfAbsent>
  >;
  try {
    casResult = await ChatOpsThreadConversationModel.createIfAbsent({
      bindingId,
      threadId: effectiveThreadId,
      conversationId: created.id,
    });
  } catch (error) {
    // Never strand the just-created conversation without a mapping.
    await ConversationModel.delete(created.id, senderUserId, organizationId);
    throw error;
  }
  const { mapping, created: won } = casResult;
  if (won) {
    return { mapping, conversation: created, senderIsOwner: true };
  }

  // Lost the race: drop our orphan and adopt the winner's conversation.
  await ConversationModel.delete(created.id, senderUserId, organizationId);
  const winner = await ConversationModel.findByIdInOrganization({
    id: mapping.conversationId,
    organizationId,
  });
  if (!winner) {
    throw new Error("Failed to resolve the ChatOps thread conversation");
  }
  return {
    mapping,
    conversation: winner,
    senderIsOwner: winner.userId === senderUserId,
  };
}

/**
 * Persist thread messages that arrived since the last ingested provider ts
 * (other participants' chatter between agent invocations) as individual,
 * attributed user rows, then CAS-advance the cursor. Rows whose
 * providerMessageId is already present are skipped, so duplicate webhook
 * deliveries and cursor races cannot double-ingest.
 */
export async function ingestProviderDelta(params: {
  mapping: ChatOpsThreadConversation;
  provider: ChatOpsProviderType;
  entries: Array<{
    providerMessageId: string;
    /** Provider-native ordering token (e.g. Slack ts). */
    providerTs: string;
    text: string;
    authorName?: string;
    authorUserId?: string;
    sentAt?: Date;
  }>;
  existingProviderMessageIds: ReadonlySet<string>;
}): Promise<void> {
  const { mapping, provider, entries, existingProviderMessageIds } = params;
  if (entries.length === 0) {
    return;
  }

  const sorted = [...entries].sort((a, b) =>
    compareProviderTs(a.providerTs, b.providerTs),
  );
  const fresh = sorted.filter(
    (entry) =>
      !existingProviderMessageIds.has(entry.providerMessageId) &&
      entry.text.trim().length > 0,
  );

  if (fresh.length > 0) {
    const base = Date.now();
    await MessageModel.bulkCreate(
      fresh.map((entry, index) => ({
        conversationId: mapping.conversationId,
        role: "user",
        content: {
          id: crypto.randomUUID(),
          role: "user",
          parts: [{ type: "text", text: entry.text }],
          metadata: {
            chatops: {
              source: chatOpsOrigin(provider),
              providerMessageId: entry.providerMessageId,
              authorName: entry.authorName,
              authorUserId: entry.authorUserId,
            } satisfies ChatOpsMessageMetadata,
          },
        },
        createdAt: entry.sentAt ?? new Date(base + index),
      })),
    );
  }

  const newestTs = sorted[sorted.length - 1].providerTs;
  const advanced =
    await ChatOpsThreadConversationModel.advanceLastSyncedProviderTs({
      id: mapping.id,
      expectedTs: mapping.lastSyncedProviderTs,
      newTs: newestTs,
    });
  if (!advanced) {
    // Correctness rests on the providerMessageId dedupe above; the cursor is
    // an advisory high-water mark (not yet used to pre-filter). Log a lost
    // CAS so a persistently failing update is visible.
    logger.warn(
      { mappingId: mapping.id, newestTs },
      "[ChatOpsConversation] provider cursor CAS lost; relying on providerMessageId dedupe",
    );
  }
}

/**
 * Persist the invoking user's turn. The UIMessage id must be the exact
 * messageId sent to the A2A layer so the persisted transcript and the
 * generated assistant continuation reference the same turn.
 */
export async function persistChatOpsUserTurn(params: {
  conversationId: string;
  messageId: string;
  text: string;
  provider: ChatOpsProviderType;
  providerMessageId: string;
  authorName?: string;
  authorUserId?: string;
}): Promise<void> {
  await MessageModel.bulkCreate([
    {
      conversationId: params.conversationId,
      role: "user",
      content: {
        id: params.messageId,
        role: "user",
        parts: [{ type: "text", text: params.text }],
        metadata: {
          chatops: {
            source: chatOpsOrigin(params.provider),
            providerMessageId: params.providerMessageId,
            authorName: params.authorName,
            authorUserId: params.authorUserId,
          } satisfies ChatOpsMessageMetadata,
        },
      },
    },
  ]);
}

/**
 * Persist the assistant turn (the executor's full responseUiMessage, tool
 * parts included), tagged with the history scope that produced it. When a row
 * with the same UIMessage id already exists (an approval request whose
 * decision mutated the message), the row is updated in place — never
 * duplicated — so the web UI keeps a single, current copy of the turn.
 */
export async function persistChatOpsAssistantTurn(params: {
  conversationId: string;
  assistantMessage: UIMessage;
  provider: ChatOpsProviderType;
  contextScope: "provider" | "full";
}): Promise<void> {
  const { conversationId, assistantMessage, provider, contextScope } = params;

  const tagged: ChatMessage = {
    ...(assistantMessage as unknown as ChatMessage),
    metadata: {
      ...(assistantMessage.metadata as Record<string, unknown> | undefined),
      chatops: {
        source: chatOpsOrigin(provider),
        contextScope,
      } satisfies ChatOpsMessageMetadata,
    },
  };
  const [normalized] = normalizeChatMessagesForPersistence([tagged]);
  if (!normalized) {
    // nothing persistable in the turn (e.g. empty response) — skip
    return;
  }

  const existing = tagged.id
    ? await MessageModel.findByAnyIdInConversation(tagged.id, conversationId)
    : null;
  if (existing) {
    await MessageModel.updateContent(existing.id, normalized);
    return;
  }

  await MessageModel.bulkCreate([
    {
      conversationId,
      role: normalized.role ?? "assistant",
      content: normalized,
    },
  ]);
}

/**
 * The channel-leak guard: history a ChatOps turn may feed to the model.
 * Owners and DM senders get everything (their own web-side turns included).
 * A non-owner sender in a shared channel gets only rows born on this provider
 * — user rows tagged with this provider's source, and assistant rows whose
 * run saw provider-scoped context — so the owner's private web work never
 * leaks into the channel, directly or through an assistant turn.
 */
export function filterHistoryForChatOpsContext(params: {
  messages: ChatMessage[];
  provider: ChatOpsProviderType;
  senderIsOwner: boolean;
  isDm: boolean;
}): ChatMessage[] {
  const { messages, provider, senderIsOwner, isDm } = params;
  if (senderIsOwner || isDm) {
    return messages;
  }
  const source = chatOpsOrigin(provider);
  return messages.filter((message) => {
    const chatops = readChatOpsMetadata(message);
    if (!chatops || chatops.source !== source) {
      return false;
    }
    if (message.role === "assistant") {
      return chatops.contextScope === "provider";
    }
    return true;
  });
}

/** Provider-message ids already represented in the loaded history. */
export function collectProviderMessageIds(
  messages: ChatMessage[],
): Set<string> {
  const ids = new Set<string>();
  for (const message of messages) {
    const providerMessageId = readChatOpsMetadata(message)?.providerMessageId;
    if (providerMessageId) {
      ids.add(providerMessageId);
    }
  }
  return ids;
}

/**
 * Record a failed ChatOps turn on the thread's conversation so the web view
 * renders the same inline error card interactive chat shows.
 */
export async function recordChatOpsConversationError(params: {
  conversationId: string;
  error: ChatErrorResponse;
}): Promise<void> {
  await ConversationChatErrorModel.create({
    conversationId: params.conversationId,
    error: params.error,
  });
}

// =============================================================================
// INTERNAL
// =============================================================================

function readChatOpsMetadata(
  message: ChatMessage,
): ChatOpsMessageMetadata | null {
  const metadata = message.metadata;
  if (
    metadata &&
    typeof metadata === "object" &&
    "chatops" in metadata &&
    typeof (metadata as { chatops: unknown }).chatops === "object" &&
    (metadata as { chatops: unknown }).chatops !== null
  ) {
    return (metadata as { chatops: ChatOpsMessageMetadata }).chatops;
  }
  return null;
}

// Provider ordering tokens are numeric-ish (Slack "1700.201", Teams/Telegram
// integer ids); plain localeCompare would order "10" before "9".
function compareProviderTs(a: string, b: string): number {
  const numericA = Number(a);
  const numericB = Number(b);
  if (
    Number.isFinite(numericA) &&
    Number.isFinite(numericB) &&
    numericA !== numericB
  ) {
    return numericA - numericB;
  }
  return a.localeCompare(b);
}

function buildSeedTitle(text: string): string {
  const normalized = text.trim().replace(/\s+/g, " ");
  if (!normalized) {
    return "ChatOps thread";
  }
  return normalized.length > 72
    ? `${normalized.slice(0, 69).trimEnd()}...`
    : normalized;
}

const CHATOPS_ORIGINS: Record<ChatOpsProviderType, ConversationOrigin> = {
  slack: "chatops:slack",
  "ms-teams": "chatops:ms-teams",
  telegram: "chatops:telegram",
};
