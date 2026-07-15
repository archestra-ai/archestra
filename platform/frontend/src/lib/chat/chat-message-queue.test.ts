import { describe, expect, it, vi } from "vitest";
import { chatMessageQueue } from "@/lib/chat/chat-message-queue";
import { conversationStorageKeys } from "@/lib/chat/chat-utils";

// The store under test is a singleton with a per-conversation lazy-load
// cache, so every test uses a fresh conversation id for isolation.
function freshConversationId(): string {
  return `conv-${crypto.randomUUID()}`;
}

function storageKey(conversationId: string): string {
  return conversationStorageKeys(conversationId).messageQueue;
}

describe("chatMessageQueue", () => {
  it("enqueues messages in order and persists them to localStorage", () => {
    const conversationId = freshConversationId();

    chatMessageQueue.enqueue(conversationId, { text: "first" });
    chatMessageQueue.enqueue(conversationId, { text: "second" });

    const queue = chatMessageQueue.get(conversationId);
    expect(queue.map((m) => m.text)).toEqual(["first", "second"]);
    expect(queue[0].id).toBeTruthy();
    expect(queue[0].queuedAt).toBeTruthy();

    const persisted = JSON.parse(
      localStorage.getItem(storageKey(conversationId)) ?? "[]",
    );
    expect(persisted.map((m: { text: string }) => m.text)).toEqual([
      "first",
      "second",
    ]);
  });

  it("keeps queues isolated per conversation", () => {
    const conversationA = freshConversationId();
    const conversationB = freshConversationId();

    chatMessageQueue.enqueue(conversationA, { text: "for A" });
    chatMessageQueue.enqueue(conversationB, { text: "for B" });

    expect(chatMessageQueue.get(conversationA).map((m) => m.text)).toEqual([
      "for A",
    ]);
    expect(chatMessageQueue.get(conversationB).map((m) => m.text)).toEqual([
      "for B",
    ]);
  });

  it("takeNext dequeues FIFO and clears storage when the queue empties", () => {
    const conversationId = freshConversationId();
    chatMessageQueue.enqueue(conversationId, { text: "first" });
    chatMessageQueue.enqueue(conversationId, { text: "second" });

    expect(chatMessageQueue.takeNext(conversationId)?.text).toBe("first");
    expect(chatMessageQueue.takeNext(conversationId)?.text).toBe("second");
    expect(chatMessageQueue.takeNext(conversationId)).toBeNull();
    expect(localStorage.getItem(storageKey(conversationId))).toBeNull();
  });

  it("removes a specific queued message by id", () => {
    const conversationId = freshConversationId();
    chatMessageQueue.enqueue(conversationId, { text: "keep" });
    const removed = chatMessageQueue.enqueue(conversationId, {
      text: "remove",
    });

    chatMessageQueue.remove(conversationId, removed.id);

    expect(chatMessageQueue.get(conversationId).map((m) => m.text)).toEqual([
      "keep",
    ]);
  });

  it("clear drops the queue and its persisted copy", () => {
    const conversationId = freshConversationId();
    chatMessageQueue.enqueue(conversationId, { text: "queued" });

    chatMessageQueue.clear(conversationId);

    expect(chatMessageQueue.get(conversationId)).toHaveLength(0);
    expect(localStorage.getItem(storageKey(conversationId))).toBeNull();
  });

  it("hydrates a queue persisted by a previous page load", () => {
    const conversationId = freshConversationId();
    localStorage.setItem(
      storageKey(conversationId),
      JSON.stringify([
        {
          id: "persisted-1",
          text: "hello from before the refresh",
          queuedAt: "2026-07-07T00:00:00.000Z",
          skill: { id: "skill-1", name: "my-skill" },
        },
      ]),
    );

    const queue = chatMessageQueue.get(conversationId);
    expect(queue).toHaveLength(1);
    expect(queue[0].text).toBe("hello from before the refresh");
    expect(queue[0].skill).toEqual({ id: "skill-1", name: "my-skill" });
  });

  it("drops malformed persisted entries instead of trusting them", () => {
    const malformedJson = freshConversationId();
    localStorage.setItem(storageKey(malformedJson), "not json {");
    expect(chatMessageQueue.get(malformedJson)).toHaveLength(0);

    const notAnArray = freshConversationId();
    localStorage.setItem(storageKey(notAnArray), JSON.stringify({ nope: 1 }));
    expect(chatMessageQueue.get(notAnArray)).toHaveLength(0);

    const mixedEntries = freshConversationId();
    localStorage.setItem(
      storageKey(mixedEntries),
      JSON.stringify([
        { id: "ok", text: "valid", queuedAt: "2026-07-07T00:00:00.000Z" },
        { text: "missing id" },
        "just a string",
        null,
      ]),
    );
    expect(chatMessageQueue.get(mixedEntries).map((m) => m.text)).toEqual([
      "valid",
    ]);
  });

  it("notifies subscribers on changes and keeps snapshots referentially stable", () => {
    const conversationId = freshConversationId();
    const listener = vi.fn();
    const unsubscribe = chatMessageQueue.subscribe(listener);

    chatMessageQueue.enqueue(conversationId, { text: "one" });
    expect(listener).toHaveBeenCalledTimes(1);

    const snapshotA = chatMessageQueue.get(conversationId);
    const snapshotB = chatMessageQueue.get(conversationId);
    expect(snapshotA).toBe(snapshotB);

    chatMessageQueue.enqueue(conversationId, { text: "two" });
    expect(listener).toHaveBeenCalledTimes(2);
    expect(chatMessageQueue.get(conversationId)).not.toBe(snapshotA);

    unsubscribe();
    chatMessageQueue.enqueue(conversationId, { text: "three" });
    expect(listener).toHaveBeenCalledTimes(2);
  });
});
