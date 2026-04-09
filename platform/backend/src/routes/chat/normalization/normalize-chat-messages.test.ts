import { describe, expect, test } from "vitest";
import { normalizeChatMessages } from "./normalize-chat-messages";

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
