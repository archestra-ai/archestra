import type { UIMessage } from "@ai-sdk/react";
import { describe, expect, test } from "vitest";
import {
  chooseDisplayedMessages,
  restoreRenderableAssistantParts,
} from "./chat-session-utils";

describe("restoreRenderableAssistantParts", () => {
  test("preserves previous assistant parts when the same assistant message becomes empty", () => {
    const previousMessages = [
      {
        id: "user-1",
        role: "user",
        parts: [{ type: "text", text: "call your tool" }],
      },
      {
        id: "assistant-1",
        role: "assistant",
        parts: [{ type: "text", text: "I called the tool successfully." }],
      },
    ] as UIMessage[];

    const nextMessages = [
      previousMessages[0],
      {
        id: "assistant-1",
        role: "assistant",
        parts: [{ type: "text", text: "" }],
      },
    ] as UIMessage[];

    expect(
      restoreRenderableAssistantParts({ previousMessages, nextMessages }),
    ).toEqual([
      previousMessages[0],
      {
        id: "assistant-1",
        role: "assistant",
        parts: [{ type: "text", text: "I called the tool successfully." }],
      },
    ]);
  });

  test("does not restore parts onto a different assistant message after list changes", () => {
    const previousMessages = [
      {
        id: "assistant-1",
        role: "assistant",
        parts: [{ type: "text", text: "first response" }],
      },
    ] as UIMessage[];

    const nextMessages = [
      {
        id: "assistant-2",
        role: "assistant",
        parts: [{ type: "text", text: "" }],
      },
    ] as UIMessage[];

    expect(
      restoreRenderableAssistantParts({ previousMessages, nextMessages }),
    ).toBe(nextMessages);
  });

  test("does not overwrite assistant messages that still have renderable parts", () => {
    const previousMessages = [
      {
        id: "assistant-1",
        role: "assistant",
        parts: [{ type: "text", text: "previous" }],
      },
    ] as UIMessage[];

    const nextMessages = [
      {
        id: "assistant-1",
        role: "assistant",
        parts: [{ type: "text", text: "latest" }],
      },
    ] as UIMessage[];

    expect(
      restoreRenderableAssistantParts({ previousMessages, nextMessages }),
    ).toEqual(nextMessages);
  });

  test("returns the original nextMessages array when no restoration is needed", () => {
    const previousMessages = [
      {
        id: "assistant-1",
        role: "assistant",
        parts: [{ type: "text", text: "previous" }],
      },
    ] as UIMessage[];

    const nextMessages = [
      {
        id: "assistant-1",
        role: "assistant",
        parts: [{ type: "text", text: "latest" }],
      },
    ] as UIMessage[];

    expect(
      restoreRenderableAssistantParts({ previousMessages, nextMessages }),
    ).toBe(nextMessages);
  });

  test("restores assistant parts when a streamed assistant message is re-keyed but stays in the same position", () => {
    const previousMessages = [
      {
        id: "user-1",
        role: "user",
        parts: [{ type: "text", text: "call your tool" }],
      },
      {
        id: "assistant-temp-id",
        role: "assistant",
        parts: [{ type: "text", text: "I called the tool successfully." }],
      },
    ] as UIMessage[];

    const nextMessages = [
      previousMessages[0],
      {
        id: "assistant-final-id",
        role: "assistant",
        parts: [{ type: "text", text: "" }],
      },
    ] as UIMessage[];

    expect(
      restoreRenderableAssistantParts({ previousMessages, nextMessages }),
    ).toEqual([
      previousMessages[0],
      {
        id: "assistant-final-id",
        role: "assistant",
        parts: [{ type: "text", text: "I called the tool successfully." }],
      },
    ]);
  });

  test("does not restore by position when earlier messages changed", () => {
    const previousMessages = [
      {
        id: "user-1",
        role: "user",
        parts: [{ type: "text", text: "first" }],
      },
      {
        id: "assistant-temp-id",
        role: "assistant",
        parts: [{ type: "text", text: "previous response" }],
      },
    ] as UIMessage[];

    const nextMessages = [
      {
        id: "user-2",
        role: "user",
        parts: [{ type: "text", text: "different" }],
      },
      {
        id: "assistant-final-id",
        role: "assistant",
        parts: [{ type: "text", text: "" }],
      },
    ] as UIMessage[];

    expect(
      restoreRenderableAssistantParts({ previousMessages, nextMessages }),
    ).toBe(nextMessages);
  });

  test("restores a truncated assistant tail when the live session briefly drops the final assistant message", () => {
    const previousMessages = [
      {
        id: "user-1",
        role: "user",
        parts: [{ type: "text", text: "call your tool" }],
      },
      {
        id: "assistant-1",
        role: "assistant",
        parts: [{ type: "text", text: "I called the tool successfully." }],
      },
    ] as UIMessage[];

    const nextMessages = [previousMessages[0]] as UIMessage[];

    expect(
      restoreRenderableAssistantParts({ previousMessages, nextMessages }),
    ).toEqual(previousMessages);
  });

  test("restores the previous thread when the live session briefly clears after an assistant response", () => {
    const previousMessages = [
      {
        id: "user-1",
        role: "user",
        parts: [{ type: "text", text: "call your tool" }],
      },
      {
        id: "assistant-1",
        role: "assistant",
        parts: [{ type: "text", text: "I called the tool successfully." }],
      },
    ] as UIMessage[];

    const nextMessages = [] as UIMessage[];

    expect(
      restoreRenderableAssistantParts({ previousMessages, nextMessages }),
    ).toEqual(previousMessages);
  });
});

describe("chooseDisplayedMessages", () => {
  test("prefers the last visible thread when live messages regress to a user-only tail", () => {
    const lastVisibleMessages = [
      {
        id: "user-1",
        role: "user",
        parts: [{ type: "text", text: "call your test tool" }],
      },
      {
        id: "assistant-1",
        role: "assistant",
        parts: [{ type: "text", text: "The test tool returns: ok" }],
      },
    ] as UIMessage[];

    const liveMessages = [lastVisibleMessages[0]] as UIMessage[];

    expect(
      chooseDisplayedMessages({
        liveMessages,
        persistedMessages: liveMessages,
        lastVisibleMessages,
      }),
    ).toEqual(lastVisibleMessages);
  });

  test("uses the persisted thread when there is no visible regression", () => {
    const persistedMessages = [
      {
        id: "user-1",
        role: "user",
        parts: [{ type: "text", text: "call your test tool" }],
      },
      {
        id: "assistant-1",
        role: "assistant",
        parts: [{ type: "text", text: "The test tool returns: ok" }],
      },
    ] as UIMessage[];

    expect(
      chooseDisplayedMessages({
        persistedMessages,
        lastVisibleMessages: [],
      }),
    ).toEqual(persistedMessages);
  });
});
