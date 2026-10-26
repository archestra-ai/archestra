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

  it("takes the entire requested batch once, preserving metadata and attachments", () => {
    const id = freshConversationId();
    const first = chatMessageQueue.enqueue(id, {
      text: "first",
      files: [
        {
          url: "data:text/plain;base64,SGk=",
          mediaType: "text/plain",
          filename: "note.txt",
        },
      ],
      skill: { id: "skill-1", name: "review" },
    });
    const second = chatMessageQueue.enqueue(id, { text: "second" });
    chatMessageQueue.requestBatch(id);
    expect(chatMessageQueue.takeForTurn(id)).toEqual([first, second]);
    expect(chatMessageQueue.takeForTurn(id)).toEqual([]);
    expect(localStorage.getItem(`${storageKey(id)}:batch`)).toBeNull();
    chatMessageQueue.enqueue(id, { text: "later" });
    chatMessageQueue.enqueue(id, { text: "still later" });
    expect(chatMessageQueue.takeForTurn(id)).toHaveLength(1);
  });

  it("restores batch intent from storage and includes additions made while stopping", () => {
    const id = freshConversationId();
    chatMessageQueue.enqueue(id, { text: "first" });
    localStorage.setItem(`${storageKey(id)}:batch`, "true");
    chatMessageQueue.enqueue(id, { text: "second" });
    expect(chatMessageQueue.takeForTurn(id).map(({ text }) => text)).toEqual([
      "first",
      "second",
    ]);
  });

  it("does not batch an explicit sandbox command added while stopping", () => {
    const id = freshConversationId();
    chatMessageQueue.enqueue(id, { text: "first" });
    chatMessageQueue.requestBatch(id);
    chatMessageQueue.enqueue(id, { text: "!echo hello", sandboxCommand: true });
    expect(chatMessageQueue.takeForTurn(id).map(({ text }) => text)).toEqual([
      "first",
    ]);
    expect(chatMessageQueue.takeForTurn(id).map(({ text }) => text)).toEqual([
      "!echo hello",
    ]);
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

  it("persists external MCP Skill attachment identity", () => {
    const conversationId = freshConversationId();
    const externalMcpSkill = {
      id: "11111111-1111-4111-8111-111111111111",
      mcpServerId: "33333333-3333-4333-8333-333333333333",
      uri: "skill://example/release/SKILL.md",
      name: "release-checklist",
      serverName: "Operations server",
      commandValue: "/operations-server-release-checklist",
      displayName: "Operations server [team:33333333] / release-checklist",
    };

    chatMessageQueue.enqueue(conversationId, {
      text: "Prepare the release",
      externalMcpSkill,
    });

    expect(chatMessageQueue.get(conversationId)[0].externalMcpSkill).toEqual(
      externalMcpSkill,
    );
    expect(
      JSON.parse(localStorage.getItem(storageKey(conversationId)) ?? "[]")[0]
        .externalMcpSkill,
    ).toEqual(externalMcpSkill);
  });

  it("persists small attachments with their message", () => {
    const conversationId = freshConversationId();
    const files = [
      {
        url: "data:image/png;base64,iVBORw0KGgo=",
        mediaType: "image/png",
        filename: "screenshot.png",
      },
    ];

    chatMessageQueue.enqueue(conversationId, { text: "look", files });

    expect(chatMessageQueue.get(conversationId)[0].files).toEqual(files);
    expect(
      JSON.parse(localStorage.getItem(storageKey(conversationId)) ?? "[]")[0]
        .files,
    ).toEqual(files);
  });

  it("keeps oversized attachments in memory without persisting that message", () => {
    const conversationId = freshConversationId();
    const largeImage = {
      url: `data:image/png;base64,${"A".repeat(1_100_000)}`,
      mediaType: "image/png",
      filename: "large.png",
    };

    chatMessageQueue.enqueue(conversationId, { text: "before" });
    chatMessageQueue.enqueue(conversationId, {
      text: "with image",
      files: [largeImage],
    });
    chatMessageQueue.enqueue(conversationId, { text: "after" });

    // The live queue still sends everything, attachments included.
    const queue = chatMessageQueue.get(conversationId);
    expect(queue.map((m) => m.text)).toEqual(["before", "with image", "after"]);
    expect(queue[1].files).toEqual([largeImage]);
    // The persisted copy drops the attachment message whole rather than
    // keeping it without its files.
    const persisted = JSON.parse(
      localStorage.getItem(storageKey(conversationId)) ?? "[]",
    );
    expect(persisted.map((m: { text: string }) => m.text)).toEqual([
      "before",
      "after",
    ]);
  });

  it("keeps queueing in memory when storage rejects the write", () => {
    const conversationId = freshConversationId();
    const setItem = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(() => {
        throw new DOMException("quota", "QuotaExceededError");
      });
    try {
      chatMessageQueue.enqueue(conversationId, {
        text: "still queued",
        files: [
          { url: "data:text/plain;base64,aGk=", mediaType: "text/plain" },
        ],
      });
    } finally {
      setItem.mockRestore();
    }

    expect(chatMessageQueue.get(conversationId).map((m) => m.text)).toEqual([
      "still queued",
    ]);
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
        { id: "bad-files", text: "bad files", files: [{ url: 1 }] },
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
