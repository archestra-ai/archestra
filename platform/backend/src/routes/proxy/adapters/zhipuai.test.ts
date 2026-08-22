import { describe, expect, test } from "@/test";
import type { Zhipuai } from "@/types/llm-providers";
import { zhipuaiAdapterFactory } from "./zhipuai";

type StreamChunk = Zhipuai.Types.ChatCompletionChunk;

function textChunk(text: string): StreamChunk {
  return {
    id: "chatcmpl-test",
    object: "chat.completion.chunk",
    created: 1,
    model: "glm-4",
    choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
  } as StreamChunk;
}

describe("ZhipuaiStreamAdapter policy refusal", () => {
  // A refusal appends one more content delta, which clients concatenate onto
  // what they have accumulated — so the client holds the model's text AND the
  // refusal. Recording the refusal alone deleted the model's own answer from
  // the turn, leaving anything that read it back a turn in which it never
  // spoke.
  test("keeps the streamed text and appends the refusal", () => {
    const adapter = zhipuaiAdapterFactory.createStreamAdapter();
    adapter.processChunk(textChunk("let me check"));

    adapter.formatCompleteTextSSE("blocked message");
    const response = adapter.toProviderResponse();

    expect(response.choices[0].message.content).toBe(
      "let me checkblocked message",
    );
    expect(response.choices[0].finish_reason).toBe("stop");
  });

  test("leaves an unrefused turn untouched", () => {
    const adapter = zhipuaiAdapterFactory.createStreamAdapter();
    adapter.processChunk(textChunk("all good"));

    const response = adapter.toProviderResponse();

    expect(response.choices[0].message.content).toBe("all good");
  });
});
