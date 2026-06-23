import type { UIMessage } from "@ai-sdk/react";
import {
  type archestraApiTypes,
  HOOK_RUN_PART_TYPE,
  hasRenderableAssistantContent,
} from "@archestra/shared";

const DEFAULT_SESSION_NAME = "New Chat Session";

export const PERSISTED_MESSAGE_ID_METADATA_KEY = "persistedMessageId";

export type ConversationShareVisibility = NonNullable<
  archestraApiTypes.GetChatConversationsResponses["200"][number]["share"]
>["visibility"];

/**
 * Builds the external agent ID header value for chat requests.
 * Strips non-ISO-8859-1 characters since HTTP headers reject them.
 */
export function getChatExternalAgentId(appName: string): string {
  const id = `${appName} Chat`;
  return id
    .replace(/[^\x20-\xff]/g, "")
    .replace(/ {2,}/g, " ")
    .trim();
}

/**
 * Generates localStorage keys scoped to a specific conversation.
 * Use this everywhere conversation-specific keys are read/written/removed
 * so that key formats stay in sync (especially for cleanup on deletion).
 */
export function conversationStorageKeys(conversationId: string) {
  return {
    artifactOpen: `archestra-chat-artifact-open-${conversationId}`,
    draft: `archestra_chat_draft_${conversationId}`,
  };
}

/**
 * localStorage key for the new-chat composer's prompt draft. Deliberately a
 * single, agent-independent key: the draft is the message the user is
 * composing, so switching the selected agent must NOT swap (and thereby drop)
 * what they have typed.
 */
export const NEW_CHAT_DRAFT_STORAGE_KEY = "archestra_chat_draft_new";

/**
 * Resolves the prompt-draft localStorage key for the prompt input: a
 * conversation-scoped key when editing an existing conversation, otherwise the
 * shared new-chat key. Keeping this in one place ensures the draft survives an
 * agent change on a new chat (the key does not depend on the agent).
 */
export function chatDraftStorageKey(
  conversationId: string | null | undefined,
): string {
  return conversationId
    ? conversationStorageKeys(conversationId).draft
    : NEW_CHAT_DRAFT_STORAGE_KEY;
}

/** The Storage surface the draft migration needs (a subset of `localStorage`). */
type DraftStorage = Pick<
  Storage,
  "length" | "key" | "getItem" | "setItem" | "removeItem"
>;

/**
 * One-time migration of pre-upgrade new-chat drafts. Earlier builds keyed the
 * new-chat draft by agent (`archestra_chat_draft_new_<agentId>`); this build
 * uses a single agent-independent key. Without migrating, an unsent draft
 * written before the upgrade would be ignored — and then cleared — on the next
 * new chat. Adopt one legacy draft into the shared key when it is empty, then
 * remove every legacy key so the migration effectively runs once. Idempotent.
 */
export function migrateLegacyNewChatDraft(storage: DraftStorage): void {
  const legacyPrefix = `${NEW_CHAT_DRAFT_STORAGE_KEY}_`;
  const legacyKeys: string[] = [];
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i);
    if (key?.startsWith(legacyPrefix)) {
      legacyKeys.push(key);
    }
  }
  if (legacyKeys.length === 0) {
    return;
  }

  // Only adopt a legacy draft when the user has not started a new shared draft.
  if (!storage.getItem(NEW_CHAT_DRAFT_STORAGE_KEY)) {
    for (const key of legacyKeys) {
      const value = storage.getItem(key);
      if (value) {
        storage.setItem(NEW_CHAT_DRAFT_STORAGE_KEY, value);
        break;
      }
    }
  }

  for (const key of legacyKeys) {
    storage.removeItem(key);
  }
}

/**
 * Extracts a display title for a conversation.
 * Priority: explicit title > first user message > default session name
 */
export function getConversationDisplayTitle(
  title: string | null,
  // biome-ignore lint/suspicious/noExplicitAny: UIMessage structure from AI SDK is dynamic
  messages?: any[],
): string {
  if (title) return title;

  // Try to extract from first user message
  if (messages && messages.length > 0) {
    for (const msg of messages) {
      if (msg.role === "user" && msg.parts) {
        for (const part of msg.parts) {
          if (part.type === "text" && part.text) {
            return part.text;
          }
        }
      }
    }
  }

  return DEFAULT_SESSION_NAME;
}

export function getConversationShareTooltip(
  visibility: ConversationShareVisibility | undefined,
) {
  if (visibility === "team") {
    return "Shared with selected teams";
  }

  if (visibility === "user") {
    return "Shared with selected users";
  }

  return "Shared with your organization";
}

export function getManualCompactionSkippedMessage(
  reason: string | undefined,
  status?: string,
): string {
  switch (reason) {
    case "nothing_to_compact":
      if (status === "existing") {
        return "Conversation is already compacted; there is no new older context to compact yet.";
      }
      return "Only the latest user turn is available, so there is no completed earlier context to compact yet.";
    case "missing_boundary_message_id":
      return "Older context exists, but it cannot be compacted because saved message IDs are missing.";
    case "not_beneficial":
      return "Context compaction was skipped because the generated summary would not reduce context usage.";
    case "using_existing_summary":
      return "Conversation is already using compacted context.";
    case "aborted":
      return "Context compaction was cancelled.";
    default:
      return "There is no completed earlier context to compact yet.";
  }
}

export function mergePersistedMessageMetadata(params: {
  liveMessages: UIMessage[];
  persistedMessages: UIMessage[];
}): UIMessage[] {
  const remainingPersistedMessages = [...params.persistedMessages];
  let changed = false;

  const mergedMessages = params.liveMessages.map((liveMessage) => {
    const liveMetadata = getObjectMetadata(liveMessage);
    const persistedMessageId = liveMetadata[PERSISTED_MESSAGE_ID_METADATA_KEY];
    const persistedIndexById =
      typeof persistedMessageId === "string"
        ? remainingPersistedMessages.findIndex(
            (persistedMessage) => persistedMessage.id === persistedMessageId,
          )
        : -1;
    const persistedIndex =
      persistedIndexById === -1
        ? remainingPersistedMessages.findIndex((persistedMessage) =>
            messagesHaveSameRenderableContent({
              liveMessage,
              persistedMessage,
            }),
          )
        : persistedIndexById;

    if (persistedIndex === -1) {
      return liveMessage;
    }

    const [persistedMessage] = remainingPersistedMessages.splice(
      persistedIndex,
      1,
    );
    if (!persistedMessage) {
      return liveMessage;
    }

    const parts = mergePersistedHookRunParts({
      liveMessage,
      liveParts: mergePersistedUserFileParts({
        liveMessage,
        persistedMessage,
      }),
      persistedMessage,
    });

    changed =
      changed ||
      parts !== liveMessage.parts ||
      typeof persistedMessageId !== "string";
    return {
      ...liveMessage,
      parts,
      metadata: {
        ...getObjectMetadata(persistedMessage),
        ...liveMetadata,
        [PERSISTED_MESSAGE_ID_METADATA_KEY]: persistedMessage.id,
      },
    };
  });

  return changed ? mergedMessages : params.liveMessages;
}

/**
 * Resolve a live message's id in the saved thread. In-session messages keep
 * their AI SDK nanoid as the live `id`, while the saved thread keys the same
 * message by its DB UUID; mergePersistedMessageMetadata records that mapping
 * in metadata.persistedMessageId. Returns null when the message cannot be
 * found in the saved thread under either id.
 */
export function resolveCanonicalMessageId(params: {
  messageId: string;
  liveMessages: UIMessage[];
  canonicalMessages: UIMessage[] | undefined;
}): string | null {
  const { messageId, liveMessages, canonicalMessages } = params;
  if (!canonicalMessages) {
    return null;
  }

  if (canonicalMessages.some((message) => message.id === messageId)) {
    return messageId;
  }

  const liveMessage = liveMessages.find((message) => message.id === messageId);
  if (!liveMessage) {
    return null;
  }

  const persistedMessageId =
    getObjectMetadata(liveMessage)[PERSISTED_MESSAGE_ID_METADATA_KEY];
  if (
    typeof persistedMessageId === "string" &&
    persistedMessageId.length > 0 &&
    canonicalMessages.some((message) => message.id === persistedMessageId)
  ) {
    return persistedMessageId;
  }

  return null;
}

/** Replace the text of one text part of one message, immutably. */
export function applyTextEditToMessages(params: {
  messages: UIMessage[];
  messageId: string;
  partIndex: number;
  text: string;
}): UIMessage[] {
  return params.messages.map((message) => {
    if (message.id !== params.messageId) {
      return message;
    }

    return {
      ...message,
      parts: message.parts.map((part, index) =>
        index === params.partIndex && part.type === "text"
          ? { ...part, text: params.text }
          : part,
      ),
    };
  });
}

function messagesHaveSameRenderableContent(params: {
  liveMessage: UIMessage;
  persistedMessage: UIMessage;
}) {
  return (
    params.liveMessage.role === params.persistedMessage.role &&
    getMessageText(params.liveMessage) ===
      getMessageText(params.persistedMessage)
  );
}

function mergePersistedUserFileParts(params: {
  liveMessage: UIMessage;
  persistedMessage: UIMessage;
}) {
  if (
    params.liveMessage.role !== "user" ||
    !params.liveMessage.parts.some((part) => part.type === "file") ||
    !params.persistedMessage.parts.some((part) => part.type === "file")
  ) {
    return params.liveMessage.parts;
  }

  return params.persistedMessage.parts;
}

function isHookRunPart(part: { type: string }): boolean {
  return part.type === HOOK_RUN_PART_TYPE;
}

/**
 * Reconcile inline `data-hook-run` debug parts on an assistant message with the
 * server's read-gated view. The server decides visibility (hook parts are
 * returned only while the conversation has debug mode on and the viewer is an
 * admin), so the persisted message is authoritative: its hook parts are spliced
 * into the live parts at the slot they occupy among the persisted non-hook
 * parts, and live hook parts the server no longer returns are dropped. This is
 * what makes the `/debug` toggle take effect without a reload — the toggle
 * invalidates the conversation query and this merge folds the refetched view
 * into the live chat state. Idempotent: returns the live parts reference
 * unchanged when nothing differs, so the sync effect settles.
 */
function mergePersistedHookRunParts(params: {
  liveMessage: UIMessage;
  liveParts: UIMessage["parts"];
  persistedMessage: UIMessage;
}): UIMessage["parts"] {
  const { liveMessage, liveParts, persistedMessage } = params;
  if (liveMessage.role !== "assistant") {
    return liveParts;
  }
  const persistedHookParts = persistedMessage.parts.filter(isHookRunPart);
  if (persistedHookParts.length === 0 && !liveParts.some(isHookRunPart)) {
    return liveParts;
  }

  const merged = liveParts.filter((part) => !isHookRunPart(part));

  // Stripping must never leave the message with nothing renderable — the
  // render-time restore-on-regression guard would resurrect the parts and
  // fight this merge in an update loop. Keep the live view for that (rare,
  // hook-chips-only) message instead.
  if (
    persistedHookParts.length === 0 &&
    !hasRenderableAssistantContent({ parts: merged })
  ) {
    return liveParts;
  }

  // Splice each persisted hook part in at the slot it occupies among the
  // persisted message's non-hook parts ("after k non-hook parts"), preserving
  // its turn-start / tool-bracket / turn-end position.
  let nonHookSeen = 0;
  let inserted = 0;
  for (const part of persistedMessage.parts) {
    if (isHookRunPart(part)) {
      merged.splice(Math.min(nonHookSeen + inserted, merged.length), 0, part);
      inserted++;
    } else {
      nonHookSeen++;
    }
  }

  const unchanged =
    merged.length === liveParts.length &&
    merged.every((part, index) => {
      const livePart = liveParts[index];
      if (part === livePart) {
        return true;
      }
      // Refetches rebuild hook part objects, so compare those structurally.
      return (
        livePart !== undefined &&
        isHookRunPart(part) &&
        isHookRunPart(livePart) &&
        JSON.stringify(part) === JSON.stringify(livePart)
      );
    });

  return unchanged ? liveParts : merged;
}

function getMessageText(message: UIMessage) {
  return message.parts
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

function getObjectMetadata(message: UIMessage): Record<string, unknown> {
  return typeof message.metadata === "object" && message.metadata !== null
    ? { ...message.metadata }
    : {};
}
