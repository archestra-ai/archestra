import type { UIMessage } from "@ai-sdk/react";
import { describe, expect, test } from "vitest";
import { mergePersistedMessageMetadata } from "./chat-message-metadata";

describe("mergePersistedMessageMetadata", () => {
  test("copies createdAt from the matching persisted message", () => {
    const liveMessages = [
      makeMessage({
        id: "live-1",
        text: "Hello",
        metadata: { streamOnly: true },
      }),
    ];
    const persistedMessages = [
      makeMessage({
        id: "persisted-1",
        text: "Hello",
        metadata: { createdAt: "2026-04-25T10:00:00.000Z" },
      }),
    ];

    expect(
      mergePersistedMessageMetadata({ liveMessages, persistedMessages })[0]
        .metadata,
    ).toEqual({
      createdAt: "2026-04-25T10:00:00.000Z",
      streamOnly: true,
    });
  });

  test("keeps live metadata when it already has createdAt", () => {
    const liveMessage = makeMessage({
      id: "live-1",
      text: "Hello",
      metadata: { createdAt: "2026-04-25T11:00:00.000Z" },
    });

    expect(
      mergePersistedMessageMetadata({
        liveMessages: [liveMessage],
        persistedMessages: [
          makeMessage({
            id: "persisted-1",
            text: "Hello",
            metadata: { createdAt: "2026-04-25T10:00:00.000Z" },
          }),
        ],
      })[0],
    ).toBe(liveMessage);
  });

  test("does not merge metadata from a different role or text", () => {
    const liveMessage = makeMessage({ id: "live-1", text: "Hello" });

    expect(
      mergePersistedMessageMetadata({
        liveMessages: [liveMessage],
        persistedMessages: [
          makeMessage({
            id: "persisted-1",
            role: "assistant",
            text: "Hello",
            metadata: { createdAt: "2026-04-25T10:00:00.000Z" },
          }),
          makeMessage({
            id: "persisted-2",
            text: "Different",
            metadata: { createdAt: "2026-04-25T10:00:00.000Z" },
          }),
        ],
      })[0],
    ).toBe(liveMessage);
  });
});

function makeMessage(params: {
  id: string;
  role?: "user" | "assistant";
  text: string;
  metadata?: UIMessage["metadata"];
}): UIMessage {
  return {
    id: params.id,
    role: params.role ?? "user",
    parts: [{ type: "text", text: params.text }],
    metadata: params.metadata,
  };
}
