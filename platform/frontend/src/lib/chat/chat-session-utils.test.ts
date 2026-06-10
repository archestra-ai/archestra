import type { UIMessage } from "@ai-sdk/react";
import { describe, expect, test } from "vitest";
import {
  pruneEmptyTrailingAssistantMessage,
  restoreRenderableAssistantParts,
  shouldFreezeChatMessages,
} from "./chat-session-utils";

describe("shouldFreezeChatMessages", () => {
  const userMessage = {
    id: "user-1",
    role: "user",
    parts: [{ type: "text", text: "write a story" }],
  } as UIMessage;
  const partialAssistant = {
    id: "assistant-1",
    role: "assistant",
    parts: [{ type: "text", text: "Once upon a time" }],
  } as UIMessage;
  const emptyAssistant = {
    id: "assistant-1",
    role: "assistant",
    parts: [],
  } as unknown as UIMessage;
  const frozen = [userMessage, partialAssistant];

  test("freezes while recovering and the live tail has no renderable assistant content", () => {
    // regenerate() dropped the partial answer — live list ends with the user message
    expect(
      shouldFreezeChatMessages({
        isRecovering: true,
        liveMessages: [userMessage],
        frozenMessages: frozen,
      }),
    ).toBe(true);

    // replay restarted the assistant message but no content has arrived yet
    expect(
      shouldFreezeChatMessages({
        isRecovering: true,
        liveMessages: [userMessage, emptyAssistant],
        frozenMessages: frozen,
      }),
    ).toBe(true);
  });

  test("unfreezes once the recovered stream renders assistant content again", () => {
    expect(
      shouldFreezeChatMessages({
        isRecovering: true,
        liveMessages: [userMessage, partialAssistant],
        frozenMessages: frozen,
      }),
    ).toBe(false);
  });

  test("never freezes outside recovery or without a frozen snapshot", () => {
    expect(
      shouldFreezeChatMessages({
        isRecovering: false,
        liveMessages: [userMessage],
        frozenMessages: frozen,
      }),
    ).toBe(false);
    expect(
      shouldFreezeChatMessages({
        isRecovering: true,
        liveMessages: [userMessage],
        frozenMessages: [],
      }),
    ).toBe(false);
  });
});

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

describe("pruneEmptyTrailingAssistantMessage", () => {
  test("drops a trailing assistant left with only step-start/telemetry after dangling-tool stripping", () => {
    const messages = [
      {
        id: "user-1",
        role: "user",
        parts: [{ type: "text", text: "go" }],
      },
      {
        id: "assistant-1",
        role: "assistant",
        parts: [
          { type: "step-start" },
          { type: "data-token-usage", data: { totalTokens: 10 } },
        ],
      },
    ] as UIMessage[];

    expect(pruneEmptyTrailingAssistantMessage(messages)).toEqual([messages[0]]);
  });

  test("keeps a trailing assistant that still renders text", () => {
    const messages = [
      {
        id: "assistant-1",
        role: "assistant",
        parts: [{ type: "step-start" }, { type: "text", text: "done" }],
      },
    ] as UIMessage[];

    expect(pruneEmptyTrailingAssistantMessage(messages)).toEqual(messages);
  });
});

describe("restoreTruncatedAssistantTail renderability gating", () => {
  test("does not restore a truncated tail that is a telemetry-only assistant", () => {
    const previousMessages = [
      {
        id: "user-1",
        role: "user",
        parts: [{ type: "text", text: "go" }],
      },
      {
        id: "assistant-1",
        role: "assistant",
        parts: [
          { type: "step-start" },
          { type: "data-token-usage", data: { totalTokens: 10 } },
        ],
      },
    ] as UIMessage[];

    const nextMessages = [previousMessages[0]] as UIMessage[];

    expect(
      restoreRenderableAssistantParts({ previousMessages, nextMessages }),
    ).toEqual(nextMessages);
  });

  test("does not restore when the live session clears to a non-renderable assistant tail", () => {
    const previousMessages = [
      {
        id: "user-1",
        role: "user",
        parts: [{ type: "text", text: "go" }],
      },
      {
        id: "assistant-1",
        role: "assistant",
        parts: [{ type: "step-start" }],
      },
    ] as UIMessage[];

    const nextMessages = [] as UIMessage[];

    expect(
      restoreRenderableAssistantParts({ previousMessages, nextMessages }),
    ).toEqual(nextMessages);
  });
});
