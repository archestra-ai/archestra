import { describe, expect, test } from "vitest";
import {
  dropEmptyAssistantMessages,
  normalizeChatMessages,
} from "./normalize-chat-messages";

describe("normalizeChatMessages", () => {
  test("dedupes duplicate tool parts with the same toolCallId", () => {
    const messages = [
      {
        id: "msg1",
        role: "assistant" as const,
        parts: [
          { type: "text", text: "Creating the agent now." },
          {
            type: "tool-archestra__create_agent",
            toolCallId: "call_create_1",
            state: "output-available",
            output: "created",
          },
          {
            type: "tool-archestra__create_agent",
            toolCallId: "call_create_1",
            state: "output-available",
            output: "created",
          },
          {
            type: "tool-archestra__swap_agent",
            toolCallId: "call_swap_1",
            state: "output-available",
            output: "swapped",
          },
          {
            type: "tool-archestra__swap_agent",
            toolCallId: "call_swap_1",
            state: "output-available",
            output: "swapped",
          },
        ],
      },
    ];

    const result = normalizeChatMessages(messages);
    const dedupedParts = result[0].parts ?? [];

    expect(dedupedParts).toHaveLength(3);
    expect(
      dedupedParts.filter((part) => part.toolCallId === "call_create_1"),
    ).toHaveLength(1);
    expect(
      dedupedParts.filter((part) => part.toolCallId === "call_swap_1"),
    ).toHaveLength(1);
  });

  test("drops a dangling input-streaming tool call (stopped mid-stream)", () => {
    const messages = [
      {
        id: "msg1",
        role: "assistant" as const,
        parts: [
          { type: "text", text: "Looking that up." },
          {
            type: "tool-archestra__create_agent",
            toolCallId: "call_interrupted",
            state: "input-streaming",
            input: { name: "Ag" },
          },
        ],
      },
    ];

    const result = normalizeChatMessages(messages);

    expect(result[0].parts).toEqual([
      { type: "text", text: "Looking that up." },
    ]);
  });

  test("preserves distinct tool parts when toolCallIds differ", () => {
    const messages = [
      {
        id: "msg1",
        role: "assistant" as const,
        parts: [
          {
            type: "tool-archestra__create_agent",
            toolCallId: "call_create_1",
            state: "output-available",
            output: "created-1",
          },
          {
            type: "tool-archestra__create_agent",
            toolCallId: "call_create_2",
            state: "output-available",
            output: "created-2",
          },
        ],
      },
    ];

    const result = normalizeChatMessages(messages);

    expect(result[0].parts).toHaveLength(2);
  });
});

describe("dropEmptyAssistantMessages", () => {
  test("drops an assistant turn left empty after a dangling tool call is stripped", () => {
    // a stopped/interrupted turn whose only part is an unresolved tool call
    const messages = [
      {
        id: "user1",
        role: "user" as const,
        parts: [{ type: "text", text: "go" }],
      },
      {
        id: "assistant1",
        role: "assistant" as const,
        parts: [
          {
            type: "tool-archestra__create_agent",
            toolCallId: "call_interrupted",
            state: "input-available",
            input: {},
          },
        ],
      },
    ];

    const normalized = normalizeChatMessages(messages);
    const result = dropEmptyAssistantMessages(normalized);

    expect(result.map((m) => m.id)).toEqual(["user1"]);
  });

  test("keeps assistant turns that still render text or a completed tool result", () => {
    const messages = [
      {
        id: "with-text",
        role: "assistant" as const,
        parts: [{ type: "text", text: "done" }],
      },
      {
        id: "with-result",
        role: "assistant" as const,
        parts: [
          {
            type: "tool-archestra__create_agent",
            toolCallId: "call_ok",
            state: "output-available",
            output: "created",
          },
        ],
      },
    ];

    const result = dropEmptyAssistantMessages(messages);

    expect(result.map((m) => m.id)).toEqual(["with-text", "with-result"]);
  });

  test("leaves non-assistant messages untouched even when empty", () => {
    const messages = [
      { id: "u", role: "user" as const, parts: [] },
      { id: "s", role: "system" as const, parts: [] },
    ];

    expect(dropEmptyAssistantMessages(messages)).toEqual(messages);
  });
});
