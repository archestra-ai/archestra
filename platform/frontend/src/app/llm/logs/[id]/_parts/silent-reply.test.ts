import { DynamicInteraction, type Interaction } from "@archestra/shared";
import { describe, expect, it } from "vitest";
import { silentReplyExplanation } from "./silent-reply";

/** The conversation the Conversation tab renders for a chat completion. */
function chat(message: object, finishReason = "stop") {
  const response = {
    id: "chatcmpl-1",
    object: "chat.completion",
    created: 0,
    model: "gpt-x",
    choices: [{ index: 0, message, finish_reason: finishReason }],
  };
  const interaction = new DynamicInteraction({
    type: "openai:chatCompletions",
    model: "gpt-x",
    request: {
      model: "gpt-x",
      messages: [{ role: "user", content: "Say hello." }],
    },
    response,
  } as unknown as Interaction);
  return { messages: interaction.mapToUiMessages(), response };
}

describe("silentReplyExplanation", () => {
  it("says so when a reply has no text, tool calls or transcript", () => {
    const { messages, response } = chat(
      { role: "assistant", content: "" },
      "length",
    );
    expect(silentReplyExplanation({ messages, response, failed: false })).toBe(
      "The model returned no text, tool calls or transcript. It stopped at its output limit before writing any.",
    );
  });

  it("stays quiet for a text reply, a spoken reply, and a failed call", () => {
    const text = chat({ role: "assistant", content: "Hello!" });
    expect(silentReplyExplanation({ ...text, failed: false })).toBeNull();

    const spoken = chat({
      role: "assistant",
      content: null,
      audio: { id: "audio_1", transcript: "Hello there." },
    });
    expect(silentReplyExplanation({ ...spoken, failed: false })).toBeNull();

    const empty = chat({ role: "assistant", content: null });
    expect(silentReplyExplanation({ ...empty, failed: true })).toBeNull();
    expect(
      silentReplyExplanation({
        messages: empty.messages,
        response: { error: { message: "upstream 500" } },
        failed: false,
      }),
    ).toBeNull();
  });

  it("leaves a request with no conversation to the empty state", () => {
    expect(
      silentReplyExplanation({ messages: [], response: {}, failed: false }),
    ).toBeNull();
  });
});
