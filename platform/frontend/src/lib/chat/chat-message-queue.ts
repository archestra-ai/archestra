// Per-conversation queue of chat messages composed while a response is
// in-flight. Submitting while a turn is streaming enqueues here instead of
// stopping the stream; each conversation's ChatSessionHook drains its own
// queue (one message per settled turn) when its status returns to "ready".
//
// Queues are persisted to localStorage under a conversation-scoped key (see
// conversationStorageKeys) so they survive page refreshes and conversation
// switches. The in-memory map is the source of truth once a conversation's
// queue has been loaded; arrays are treated as immutable (replaced on every
// change) so useSyncExternalStore snapshots stay referentially stable.
//
// Attachments ride along as base64 `data:` URLs, which can be megabytes, so
// persistence is best-effort: a message whose attachments would push the
// persisted queue past PERSISTED_QUEUE_BUDGET_CHARS (or past the browser's
// storage quota) stays in memory only and does not survive a reload. Such a
// message is dropped from the persisted copy whole — never persisted without
// its files — so a reload never sends it stripped of its attachments.

import type {
  ChatExternalMcpSkillMetadata,
  ChatSkillMetadata,
} from "@archestra/shared";
import { useSyncExternalStore } from "react";
import { conversationStorageKeys } from "@/lib/chat/chat-utils";
import { generateUuid } from "@/lib/uuid";

export interface QueuedChatMessage {
  id: string;
  text: string;
  /** ISO timestamp of when the message was enqueued. */
  queuedAt: string;
  /** Skill activated via a slash command, resolved at enqueue time. */
  skill?: ChatSkillMetadata;
  /** Live MCP Skill attached explicitly to this queued turn. */
  externalMcpSkill?: ChatExternalMcpSkillMetadata;
  /** Marks a `!`-prefixed message for direct sandbox execution. */
  sandboxCommand?: true;
  /** Attachments, each `url` already the base64 `data:` URL sent on the wire. */
  files?: QueuedChatFile[];
}

export interface QueuedChatFile {
  url: string;
  mediaType: string;
  filename?: string;
}

export type EnqueueChatMessageInput = Omit<
  QueuedChatMessage,
  "id" | "queuedAt"
>;

class ChatMessageQueueStore {
  private queues = new Map<string, readonly QueuedChatMessage[]>();
  private loadedConversationIds = new Set<string>();
  private listeners = new Set<() => void>();
  private batchRequested = new Set<string>();

  /** Snapshot of a conversation's queue (stable reference until it changes). */
  get(conversationId: string): readonly QueuedChatMessage[] {
    this.ensureLoaded(conversationId);
    return this.queues.get(conversationId) ?? EMPTY_QUEUE;
  }

  enqueue(
    conversationId: string,
    message: EnqueueChatMessageInput,
  ): QueuedChatMessage {
    const queued: QueuedChatMessage = {
      ...message,
      id: generateUuid(),
      queuedAt: new Date().toISOString(),
    };
    this.setQueue(conversationId, [...this.get(conversationId), queued]);
    return queued;
  }

  remove(conversationId: string, messageId: string): void {
    const queue = this.get(conversationId);
    const next = queue.filter((message) => message.id !== messageId);
    if (next.length !== queue.length) {
      this.setQueue(conversationId, next);
    }
  }

  /** Dequeue the oldest message, or null when the queue is empty. */
  takeNext(conversationId: string): QueuedChatMessage | null {
    const [next, ...rest] = this.get(conversationId);
    if (!next) {
      return null;
    }
    this.setQueue(conversationId, rest);
    return next;
  }

  /** The next settled turn consumes all pending messages, including after reload. */
  requestBatch(conversationId: string): void {
    this.batchRequested.add(conversationId);
    try {
      localStorage.setItem(`${storageKey(conversationId)}:batch`, "true");
    } catch {
      /* Memory still retains the intent when storage is unavailable. */
    }
  }

  takeForTurn(conversationId: string): readonly QueuedChatMessage[] {
    let together = this.batchRequested.has(conversationId);
    try {
      together ||=
        localStorage.getItem(`${storageKey(conversationId)}:batch`) === "true";
    } catch {
      /* Fall back to in-memory intent. */
    }
    // Explicit shell commands must remain distinct executions, even if one
    // was added while an interrupt was settling.
    if (this.get(conversationId).some((message) => message.sandboxCommand))
      together = false;
    if (!together) {
      const next = this.takeNext(conversationId);
      return next ? [next] : [];
    }
    const batch = this.get(conversationId);
    this.setQueue(conversationId, EMPTY_QUEUE);
    return batch;
  }

  /** Drop a conversation's queue entirely (conversation deleted). */
  clear(conversationId: string): void {
    this.setQueue(conversationId, EMPTY_QUEUE);
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private ensureLoaded(conversationId: string): void {
    if (
      this.loadedConversationIds.has(conversationId) ||
      typeof window === "undefined"
    ) {
      return;
    }
    this.loadedConversationIds.add(conversationId);
    const raw = localStorage.getItem(storageKey(conversationId));
    if (!raw) {
      return;
    }
    const parsed = parsePersistedQueue(raw);
    if (parsed.length > 0) {
      this.queues.set(conversationId, parsed);
    }
  }

  private setQueue(
    conversationId: string,
    queue: readonly QueuedChatMessage[],
  ): void {
    this.ensureLoaded(conversationId);
    if (queue.length === 0) {
      this.batchRequested.delete(conversationId);
      try {
        localStorage.removeItem(`${storageKey(conversationId)}:batch`);
      } catch {
        /* Best-effort persistence, like the queue itself. */
      }
      this.queues.delete(conversationId);
    } else {
      this.queues.set(conversationId, queue);
    }
    if (typeof window !== "undefined") {
      persistQueue(storageKey(conversationId), queue);
    }
    for (const listener of this.listeners) {
      listener();
    }
  }
}

export const chatMessageQueue = new ChatMessageQueueStore();

/** Reactive view of a conversation's queued messages. */
export function useConversationMessageQueue(
  conversationId: string | null | undefined,
): readonly QueuedChatMessage[] {
  return useSyncExternalStore(
    chatMessageQueue.subscribe,
    () => (conversationId ? chatMessageQueue.get(conversationId) : EMPTY_QUEUE),
    () => EMPTY_QUEUE,
  );
}

// === Internal helpers ===

const EMPTY_QUEUE: readonly QueuedChatMessage[] = [];

/**
 * Upper bound on a persisted queue's serialized size. Browsers cap an origin's
 * localStorage at ~5MB shared with every other chat key (drafts, settings), so
 * a few queued screenshots must not crowd those out.
 */
const PERSISTED_QUEUE_BUDGET_CHARS = 1_000_000;

function storageKey(conversationId: string): string {
  return conversationStorageKeys(conversationId).messageQueue;
}

function persistQueue(key: string, queue: readonly QueuedChatMessage[]): void {
  if (queue.length === 0) {
    localStorage.removeItem(key);
    return;
  }
  const full = JSON.stringify(queue);
  if (full.length <= PERSISTED_QUEUE_BUDGET_CHARS && trySetItem(key, full)) {
    return;
  }
  // Too large to persist whole: keep the attachment-free messages durable and
  // hold the rest in memory only (see the module comment).
  const withoutAttachments = queue.filter((message) => !message.files?.length);
  if (withoutAttachments.length === 0) {
    localStorage.removeItem(key);
  } else if (!trySetItem(key, JSON.stringify(withoutAttachments))) {
    localStorage.removeItem(key);
  }
}

function trySetItem(key: string, value: string): boolean {
  try {
    localStorage.setItem(key, value);
    return true;
  } catch {
    // QuotaExceededError (or storage disabled): the in-memory queue still works.
    return false;
  }
}

/**
 * Parse a persisted queue defensively: localStorage contents are outside this
 * module's control (older builds, manual edits), so anything malformed is
 * dropped rather than trusted.
 */
function parsePersistedQueue(raw: string): QueuedChatMessage[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter(
      (entry): entry is QueuedChatMessage =>
        typeof entry === "object" &&
        entry !== null &&
        typeof (entry as QueuedChatMessage).id === "string" &&
        typeof (entry as QueuedChatMessage).text === "string" &&
        isValidPersistedFiles((entry as QueuedChatMessage).files),
    );
  } catch {
    return [];
  }
}

function isValidPersistedFiles(files: unknown): boolean {
  return (
    files === undefined ||
    (Array.isArray(files) &&
      files.every(
        (file) =>
          typeof file === "object" &&
          file !== null &&
          typeof (file as QueuedChatFile).url === "string" &&
          typeof (file as QueuedChatFile).mediaType === "string",
      ))
  );
}
