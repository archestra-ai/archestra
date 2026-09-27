import { describe, expect, test } from "vitest";
import type { Zhipuai } from "@/types/llm-providers";
import { zhipuaiAdapterFactory } from "./zhipuai";

type StreamChunk = Zhipuai.Types.ChatCompletionChunk;

function deltaOf(sseData: string | Uint8Array): Record<string, unknown> {
  const text =
    typeof sseData === "string" ? sseData : new TextDecoder().decode(sseData);
  const json = JSON.parse(text.replace(/^data: /, "").trim()) as {
    choices: Array<{ delta: Record<string, unknown> }>;
  };
  return json.choices[0].delta;
}

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

  test("streams mixed text and reasoning while buffering only its tool call", () => {
    const adapter = zhipuaiAdapterFactory.createStreamAdapter();
    const result = adapter.processChunk({
      id: "chatcmpl-mixed",
      object: "chat.completion.chunk",
      created: 1,
      model: "glm-4",
      choices: [
        {
          index: 0,
          delta: {
            role: "assistant",
            content: "I will delegate this.",
            reasoning_content: "This needs a specialist.",
            tool_calls: [
              {
                index: 0,
                id: "call_1",
                type: "function",
                function: { name: "delegate", arguments: "{}" },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    } as StreamChunk);

    if (result.sseData === null) throw new Error("expected streamable content");
    expect(deltaOf(result.sseData)).toEqual({
      role: "assistant",
      content: "I will delegate this.",
      reasoning_content: "This needs a specialist.",
    });
    expect(result.isToolCallChunk).toBe(true);

    expect(deltaOf(adapter.getRawToolCallEvents()[0])).toEqual({
      role: "assistant",
      tool_calls: expect.any(Array),
    });

    const message = adapter.toProviderResponse().choices[0].message as {
      content: string | null;
      reasoning_content?: string;
    };
    expect(message.content).toBe("I will delegate this.");
    expect(message.reasoning_content).toBe("This needs a specialist.");
  });

  test("leaves an unrefused turn untouched", () => {
    const adapter = zhipuaiAdapterFactory.createStreamAdapter();
    adapter.processChunk(textChunk("all good"));

    const response = adapter.toProviderResponse();

    expect(response.choices[0].message.content).toBe("all good");
  });
});

describe("ZhipuaiResponseAdapter", () => {
  // The governed-response replace path refuses to send a response it cannot
  // safely rewrite; without withReplacedText an admitted final answer 503'd.
  test("withReplacedText replaces the assistant message and drops tool calls", () => {
    const adapter = zhipuaiAdapterFactory.createResponseAdapter({
      id: "chatcmpl-test",
      object: "chat.completion",
      created: 1,
      model: "glm-4",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: "RAW",
            tool_calls: [
              {
                id: "call_1",
                type: "function" as const,
                function: { name: "read_file", arguments: "{}" },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    } as unknown as Zhipuai.Types.ChatCompletionsResponse);

    const replaced = adapter.withReplacedText?.("ADMITTED");

    expect(replaced?.choices[0].message.content).toBe("ADMITTED");
    expect(replaced?.choices[0].message.tool_calls).toBeUndefined();
    expect(replaced?.choices[0].finish_reason).toBe("stop");
  });
});
