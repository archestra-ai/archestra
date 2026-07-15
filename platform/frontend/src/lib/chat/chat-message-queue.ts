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

import type { ChatSkillMetadata } from "@archestra/shared";
import { useSyncExternalStore } from "react";
import { conversationStorageKeys } from "@/lib/chat/chat-utils";

export interface QueuedChatMessage {
  id: string;
  text: string;
  /** ISO timestamp of when the message was enqueued. */
  queuedAt: string;
  /** Skill activated via a slash command, resolved at enqueue time. */
  skill?: ChatSkillMetadata;
  /** Marks a `!`-prefixed message for direct sandbox execution. */
  sandboxCommand?: true;
}

export type EnqueueChatMessageInput = Omit<
  QueuedChatMessage,
  "id" | "queuedAt"
>;

class ChatMessageQueueStore {
  private queues = new Map<string, readonly QueuedChatMessage[]>();
  private loadedConversationIds = new Set<string>();
  private listeners = new Set<() => void>();

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
      id: crypto.randomUUID(),
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
      this.queues.delete(conversationId);
    } else {
      this.queues.set(conversationId, queue);
    }
    if (typeof window !== "undefined") {
      const key = storageKey(conversationId);
      if (queue.length === 0) {
        localStorage.removeItem(key);
      } else {
        localStorage.setItem(key, JSON.stringify(queue));
      }
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

function storageKey(conversationId: string): string {
  return conversationStorageKeys(conversationId).messageQueue;
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
        typeof (entry as QueuedChatMessage).text === "string",
    );
  } catch {
    return [];
  }
}
