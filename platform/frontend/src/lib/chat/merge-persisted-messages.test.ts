import type { UIMessage } from "ai";
import { describe, expect, it } from "vitest";
import { mergePersistedMessageMetadata } from "./merge-persisted-messages";

function userMessage(
  id: string,
  text: string,
  metadata?: Record<string, unknown>,
): UIMessage {
  return {
    id,
    role: "user",
    parts: [{ type: "text", text }],
    metadata,
  } as UIMessage;
}

function assistantMessage(
  id: string,
  text: string,
  metadata?: Record<string, unknown>,
): UIMessage {
  return {
    id,
    role: "assistant",
    parts: [{ type: "text", text }],
    metadata,
  } as UIMessage;
}

describe("mergePersistedMessageMetadata", () => {
  it("returns persisted messages unchanged when the live thread is empty", () => {
    const persisted = [
      userMessage("u1", "hi", { createdAt: "2026-05-05T08:00:00.000Z" }),
      assistantMessage("a1", "hello", {
        createdAt: "2026-05-05T08:00:01.000Z",
      }),
    ];

    expect(
      mergePersistedMessageMetadata({
        liveMessages: [],
        persistedMessages: persisted,
      }),
    ).toEqual(persisted);
  });

  it("decorates live messages with persisted metadata when both threads agree", () => {
    const live = [userMessage("u1", "hi"), assistantMessage("a1", "hello")];
    const persisted = [
      userMessage("u1", "hi", { createdAt: "2026-05-05T08:00:00.000Z" }),
      assistantMessage("a1", "hello", {
        createdAt: "2026-05-05T08:00:01.000Z",
      }),
    ];

    const merged = mergePersistedMessageMetadata({
      liveMessages: live,
      persistedMessages: persisted,
    });

    expect(merged).toHaveLength(2);
    expect(merged[0].metadata).toMatchObject({
      createdAt: "2026-05-05T08:00:00.000Z",
    });
    expect(merged[1].metadata).toMatchObject({
      createdAt: "2026-05-05T08:00:01.000Z",
    });
    // Original parts preserved
    expect(merged[1].parts).toEqual([{ type: "text", text: "hello" }]);
  });

  it("preserves live metadata over persisted when both define the same key", () => {
    const live = [
      assistantMessage("a1", "live text", { createdAt: "live-time" }),
    ];
    const persisted = [
      assistantMessage("a1", "persisted text", { createdAt: "persisted-time" }),
    ];

    const merged = mergePersistedMessageMetadata({
      liveMessages: live,
      persistedMessages: persisted,
    });

    // hasCreatedAtMetadata short-circuits — live message returned untouched.
    expect(merged[0]).toBe(live[0]);
  });

  it("recovers an assistant turn the live thread missed (the page-reload bug)", () => {
    // The user reloaded while the LLM was still thinking. The new useChat
    // hook started from whatever the DB had at reload time (just the user
    // message). The backend's onFinish later wrote the assistant turn to
    // the DB, but the live thread never received it.
    const live = [userMessage("u1", "what time is it?")];
    const persisted = [
      userMessage("u1", "what time is it?", {
        createdAt: "2026-05-05T08:00:00.000Z",
      }),
      assistantMessage("a1", "It's 8 AM UTC.", {
        createdAt: "2026-05-05T08:00:05.000Z",
      }),
    ];

    const merged = mergePersistedMessageMetadata({
      liveMessages: live,
      persistedMessages: persisted,
    });

    expect(merged).toHaveLength(2);
    expect(merged[0].id).toBe("u1");
    expect(merged[0].role).toBe("user");
    // The recovered assistant message keeps its persisted id + parts.
    expect(merged[1].id).toBe("a1");
    expect(merged[1].role).toBe("assistant");
    expect(merged[1].parts).toEqual([{ type: "text", text: "It's 8 AM UTC." }]);
  });

  it("does not resurrect deleted history when the live thread already ends with an assistant turn", () => {
    // The user deleted the last two messages (e.g. via the message editor's
    // "delete subsequent messages"). Persisted has a window where it still
    // shows the deleted messages until the backend invalidate completes.
    // The live tail is an assistant message — the conversation is in a
    // settled state — so we should NOT re-introduce the persisted-only
    // tail.
    const live = [userMessage("u1", "hi"), assistantMessage("a1", "hello")];
    const persisted = [
      userMessage("u1", "hi", { createdAt: "0" }),
      assistantMessage("a1", "hello", { createdAt: "1" }),
      userMessage("u2", "stale, soon-to-be-deleted", { createdAt: "2" }),
      assistantMessage("a2", "stale assistant reply", { createdAt: "3" }),
    ];

    const merged = mergePersistedMessageMetadata({
      liveMessages: live,
      persistedMessages: persisted,
    });

    expect(merged).toHaveLength(2);
    expect(merged.map((m) => m.id)).toEqual(["u1", "a1"]);
  });

  it("does not duplicate when an in-flight assistant message has matching content in persisted", () => {
    // Edge case: the assistant message has been persisted (post-onFinish)
    // and the live thread still has its in-flight copy. They share text
    // content, so content matching collapses them; we must not also append
    // the persisted copy as a trailing item.
    const live = [
      userMessage("u1", "hi"),
      assistantMessage("a1-live", "hello there"),
    ];
    const persisted = [
      userMessage("u1", "hi", { createdAt: "0" }),
      assistantMessage("a1-db", "hello there", { createdAt: "1" }),
    ];

    const merged = mergePersistedMessageMetadata({
      liveMessages: live,
      persistedMessages: persisted,
    });

    expect(merged).toHaveLength(2);
    // Live id wins (live thread is authoritative for messages it knows).
    expect(merged[1].id).toBe("a1-live");
    // Metadata still flows in from persisted.
    expect(merged[1].metadata).toMatchObject({ createdAt: "1" });
  });

  it("leaves an unmatched live message in place and still recovers a tail assistant", () => {
    // The live thread has a message the persisted thread lacks (e.g. a
    // tool-call placeholder mid-stream that the backend hasn't written
    // yet). We still want the recovered assistant turn to land at the end.
    const live = [
      userMessage("u1", "hi"),
      // Some live-only artefact (no persisted twin yet).
      {
        id: "tool-1",
        role: "user",
        parts: [{ type: "text", text: "tool placeholder" }],
      } as UIMessage,
    ];
    const persisted = [
      userMessage("u1", "hi", { createdAt: "0" }),
      assistantMessage("a1", "answer"),
    ];

    const merged = mergePersistedMessageMetadata({
      liveMessages: live,
      persistedMessages: persisted,
    });

    expect(merged.map((m) => m.id)).toEqual(["u1", "tool-1", "a1"]);
  });
});
