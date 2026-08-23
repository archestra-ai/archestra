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

  // GLM thinking mode streams its thinking in `reasoning_content`; it reached
  // the client but was never accumulated into the recorded turn.
  test("records the reasoning the model streamed", () => {
    const adapter = zhipuaiAdapterFactory.createStreamAdapter();
    adapter.processChunk({
      id: "chatcmpl-test",
      object: "chat.completion.chunk",
      created: 1,
      model: "glm-4",
      choices: [
        {
          index: 0,
          delta: { reasoning_content: "thinking" },
          finish_reason: null,
        },
      ],
    } as StreamChunk);
    adapter.processChunk(textChunk("the answer"));

    const message = adapter.toProviderResponse().choices[0].message as {
      content: string | null;
      reasoning_content?: string;
    };
    expect(message.reasoning_content).toBe("thinking");
    expect(message.content).toBe("the answer");
  });

  test("leaves an unrefused turn untouched", () => {
    const adapter = zhipuaiAdapterFactory.createStreamAdapter();
    adapter.processChunk(textChunk("all good"));

    const response = adapter.toProviderResponse();

    expect(response.choices[0].message.content).toBe("all good");
  });
});
