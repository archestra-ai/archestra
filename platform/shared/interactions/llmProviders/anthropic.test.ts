import { describe, expect, it } from "vitest";
import AnthropicMessagesInteraction from "./anthropic";
import type { Interaction } from "./common";

describe("AnthropicMessagesInteraction.getLastToolCallId", () => {
  it("returns the last tool_use_id when a user message has multiple tool_results", () => {
    const interaction = new AnthropicMessagesInteraction({
      type: "anthropic:messages",
      model: "claude-sonnet-4-5",
      request: {
        model: "claude-sonnet-4-5",
        max_tokens: 1024,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "toolu_first",
                content: "one",
              },
              {
                type: "tool_result",
                tool_use_id: "toolu_second",
                content: "two",
              },
            ],
          },
        ],
      },
      response: {
        id: "msg_1",
        content: [],
        model: "claude-sonnet-4-5",
        role: "assistant",
        stop_reason: "end_turn",
        stop_sequence: null,
        type: "message",
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    } as unknown as Interaction);

    expect(interaction.getLastToolCallId()).toBe("toolu_second");
  });
});
