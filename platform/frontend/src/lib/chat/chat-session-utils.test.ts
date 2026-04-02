import type { UIMessage } from "@ai-sdk/react";
import { describe, expect, test } from "vitest";
import { restoreRenderableAssistantParts } from "./chat-session-utils";

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
});
