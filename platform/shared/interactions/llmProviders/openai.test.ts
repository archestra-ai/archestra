import { describe, expect, it } from "vitest";
import type { Interaction } from "./common";
import OpenAiChatCompletionInteraction from "./openai";

describe("OpenAiChatCompletionInteraction", () => {
  it("maps tool calls with malformed JSON arguments without throwing", () => {
    const interaction = new OpenAiChatCompletionInteraction({
      type: "openai:chatCompletions",
      model: "gpt-4o",
      request: {
        model: "gpt-4o",
        messages: [
          {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_1",
                type: "function",
                function: {
                  name: "search",
                  arguments: "{incomplete",
                },
              },
            ],
          },
        ],
      },
      response: {
        id: "chatcmpl-1",
        choices: [],
        created: 0,
        model: "gpt-4o",
        object: "chat.completion",
      },
    } as unknown as Interaction);

    expect(() => interaction.mapToUiMessages()).not.toThrow();
    const messages = interaction.mapToUiMessages();
    expect(messages[0]?.parts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "dynamic-tool",
          toolName: "search",
          toolCallId: "call_1",
          input: "{incomplete",
        }),
      ]),
    );
  });
});
