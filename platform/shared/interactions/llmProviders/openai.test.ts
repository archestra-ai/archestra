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

  it("plays a spoken reply and shows its transcript", () => {
    // gpt-audio answers with `content: null` and the speech under `audio`.
    const interaction = new OpenAiChatCompletionInteraction({
      type: "openai:chatCompletions",
      model: "gpt-audio",
      request: {
        model: "gpt-audio",
        modalities: ["text", "audio"],
        messages: [{ role: "user", content: "Say hello in five words." }],
      },
      response: {
        id: "chatcmpl-2",
        choices: [
          {
            index: 0,
            finish_reason: "stop",
            message: {
              role: "assistant",
              content: null,
              audio: {
                id: "audio_1",
                data: "UklGRiQAAABXQVZF",
                transcript: "Hello there from Archestra!",
                expires_at: 0,
              },
            },
          },
        ],
        created: 0,
        model: "gpt-audio",
        object: "chat.completion",
      },
    } as unknown as Interaction);

    expect(interaction.getLastAssistantResponse()).toBe(
      "Hello there from Archestra!",
    );
    const messages = interaction.mapToUiMessages();
    expect(messages.at(-1)).toMatchObject({
      role: "assistant",
      parts: [
        {
          type: "file",
          mediaType: "audio/wav",
          url: "data:audio/wav;base64,UklGRiQAAABXQVZF",
        },
        { type: "text", text: "Hello there from Archestra!" },
      ],
    });
  });
});
