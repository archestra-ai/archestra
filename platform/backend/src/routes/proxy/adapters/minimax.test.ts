import { describe, expect, test } from "@/test";
import type { Minimax } from "@/types/llm-providers";
import { minimaxAdapterFactory } from "./minimax";

type StreamChunk = Minimax.Types.ChatCompletionChunk;

function reasoningChunk(cumulativeText: string): StreamChunk {
  return {
    id: "chatcmpl-test",
    object: "chat.completion.chunk",
    created: 1,
    model: "MiniMax-M2.5",
    choices: [
      {
        index: 0,
        delta: { reasoning_details: [{ text: cumulativeText }] },
        finish_reason: null,
      },
    ],
  } as StreamChunk;
}

function finalChunk(): StreamChunk {
  return {
    id: "chatcmpl-test",
    object: "chat.completion.chunk",
    created: 1,
    model: "MiniMax-M2.5",
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  } as StreamChunk;
}

function parseSse(sseData: string | Uint8Array | null) {
  expect(typeof sseData).toBe("string");
  return JSON.parse((sseData as string).slice("data: ".length)) as {
    choices: Array<{
      delta: {
        content?: string;
        reasoning_content?: string;
        reasoning_details?: Array<{ text?: string }>;
      };
    }>;
  };
}

describe("MinimaxStreamAdapter reasoning", () => {
  test("extracts deltas from cumulative reasoning_details into reasoning_content", () => {
    const adapter = minimaxAdapterFactory.createStreamAdapter();

    const first = parseSse(
      adapter.processChunk(reasoningChunk("First half, ")).sseData,
    );
    expect(first.choices[0].delta.reasoning_content).toBe("First half, ");

    const second = parseSse(
      adapter.processChunk(reasoningChunk("First half, second half.")).sseData,
    );
    expect(second.choices[0].delta.reasoning_content).toBe("second half.");
    // The native field is forwarded untouched for clients consuming
    // MiniMax's own shape.
    expect(second.choices[0].delta.reasoning_details).toEqual([
      { text: "First half, second half." },
    ]);
  });

  test("treats non-extending reasoning text as incremental chunks", () => {
    const adapter = minimaxAdapterFactory.createStreamAdapter();

    parseSse(adapter.processChunk(reasoningChunk("abc")).sseData);
    const second = parseSse(
      adapter.processChunk(reasoningChunk("def")).sseData,
    );
    expect(second.choices[0].delta.reasoning_content).toBe("def");

    adapter.processChunk(finalChunk());
    const response = adapter.toProviderResponse();
    expect(response.choices[0].message.reasoning_details).toEqual([
      { text: "abcdef" },
    ]);
  });

  test("joins multiple reasoning_details entries in one delta", () => {
    const adapter = minimaxAdapterFactory.createStreamAdapter();

    const chunk = {
      ...reasoningChunk(""),
      choices: [
        {
          index: 0,
          delta: {
            reasoning_details: [{ text: "First " }, { text: "second." }],
          },
          finish_reason: null,
        },
      ],
    } as StreamChunk;

    const parsed = parseSse(adapter.processChunk(chunk).sseData);
    expect(parsed.choices[0].delta.reasoning_content).toBe("First second.");

    adapter.processChunk(finalChunk());
    expect(
      adapter.toProviderResponse().choices[0].message.reasoning_details,
    ).toEqual([{ text: "First second." }]);
  });

  test("preserves content on chunks carrying both content and reasoning", () => {
    const adapter = minimaxAdapterFactory.createStreamAdapter();

    const chunk = {
      ...reasoningChunk(""),
      choices: [
        {
          index: 0,
          delta: {
            content: "The answer.",
            reasoning_details: [{ text: "Thinking." }],
          },
          finish_reason: null,
        },
      ],
    } as StreamChunk;

    const parsed = parseSse(adapter.processChunk(chunk).sseData);
    expect(parsed.choices[0].delta.content).toBe("The answer.");
    expect(parsed.choices[0].delta.reasoning_content).toBe("Thinking.");

    adapter.processChunk(finalChunk());
    const message = adapter.toProviderResponse().choices[0].message;
    expect(message.content).toBe("The answer.");
    expect(message.reasoning_details).toEqual([{ text: "Thinking." }]);
  });

  test("toProviderResponse carries reasoning in both dialects", () => {
    const adapter = minimaxAdapterFactory.createStreamAdapter();

    adapter.processChunk(reasoningChunk("Thinking."));
    adapter.processChunk(finalChunk());

    const message = adapter.toProviderResponse().choices[0].message;
    expect(message.reasoning_details).toEqual([{ text: "Thinking." }]);
    expect(message.reasoning_content).toBe("Thinking.");
  });
});

describe("MinimaxResponseAdapter reasoning", () => {
  test("mirrors reasoning_details into reasoning_content", () => {
    const adapter = minimaxAdapterFactory.createResponseAdapter({
      id: "chatcmpl-test",
      object: "chat.completion",
      created: 1,
      model: "MiniMax-M2.5",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: "The answer.",
            reasoning_details: [{ text: "Thinking." }],
          },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    });

    const message = adapter.getOriginalResponse().choices[0].message;
    expect(message.reasoning_content).toBe("Thinking.");
    expect(message.reasoning_details).toEqual([{ text: "Thinking." }]);
  });
});

describe("MinimaxRequestAdapter reasoning passback", () => {
  const toolCall = {
    id: "call_1",
    type: "function" as const,
    function: { name: "read_file", arguments: '{"path":"/tmp/a.txt"}' },
  };

  test("translates assistant reasoning_content into reasoning_details", () => {
    const adapter = minimaxAdapterFactory.createRequestAdapter({
      model: "MiniMax-M2.5",
      messages: [
        { role: "user", content: "Read the file" },
        {
          role: "assistant",
          content: "",
          reasoning_content: "Prior thinking.",
          tool_calls: [toolCall],
        },
        { role: "tool", tool_call_id: "call_1", content: "result" },
      ],
    });

    const request = adapter.toProviderRequest();
    const assistant = request.messages.find(
      (message) => message.role === "assistant",
    ) as Record<string, unknown>;
    expect(assistant.reasoning_details).toEqual([{ text: "Prior thinking." }]);
    expect(assistant.reasoning_content).toBeUndefined();
  });

  test("keeps existing reasoning_details untouched", () => {
    const adapter = minimaxAdapterFactory.createRequestAdapter({
      model: "MiniMax-M2.5",
      messages: [
        { role: "user", content: "Read the file" },
        {
          role: "assistant",
          content: "",
          reasoning_content: "Ignored.",
          reasoning_details: [{ text: "Native thinking." }],
          tool_calls: [toolCall],
        },
        { role: "tool", tool_call_id: "call_1", content: "result" },
      ],
    });

    const request = adapter.toProviderRequest();
    const assistant = request.messages.find(
      (message) => message.role === "assistant",
    ) as Record<string, unknown>;
    expect(assistant.reasoning_details).toEqual([{ text: "Native thinking." }]);
    expect(assistant.reasoning_content).toBeUndefined();
  });

  test("strips empty reasoning_content without adding reasoning_details", () => {
    const adapter = minimaxAdapterFactory.createRequestAdapter({
      model: "MiniMax-M2.5",
      messages: [
        { role: "user", content: "Read the file" },
        {
          role: "assistant",
          content: "",
          reasoning_content: "",
          tool_calls: [toolCall],
        },
        { role: "tool", tool_call_id: "call_1", content: "result" },
      ],
    });

    const request = adapter.toProviderRequest();
    const assistant = request.messages.find(
      (message) => message.role === "assistant",
    ) as Record<string, unknown>;
    expect(assistant.reasoning_content).toBeUndefined();
    expect(assistant.reasoning_details).toBeUndefined();
  });
});

describe("MinimaxRequestAdapter reasoning_split", () => {
  const baseRequest = {
    model: "MiniMax-M2.5",
    messages: [{ role: "user" as const, content: "Think about this" }],
  };

  // MiniMax's docs show `extra_body.reasoning_split` because their examples use
  // the OpenAI Python SDK, which merges extra_body into the top level of the
  // body. Sent as a literal nested object it is just an unknown key: the server
  // ignores it and the M-series falls back to inlining `<think>` tags in the
  // content, so no reasoning_details ever arrives.
  test("sends reasoning_split at the top level, not nested in extra_body", () => {
    const request = minimaxAdapterFactory
      .createRequestAdapter(baseRequest)
      .toProviderRequest() as Record<string, unknown>;

    expect(request.reasoning_split).toBe(true);
    expect(request.extra_body).toBeUndefined();
  });

  test("honors reasoning_split: false sent the Python-SDK way", () => {
    const request = minimaxAdapterFactory
      .createRequestAdapter({
        ...baseRequest,
        extra_body: { reasoning_split: false },
      })
      .toProviderRequest() as Record<string, unknown>;

    expect(request.reasoning_split).toBe(false);
    expect(request.extra_body).toBeUndefined();
  });

  test("honors an explicit top-level reasoning_split", () => {
    const request = minimaxAdapterFactory
      .createRequestAdapter({ ...baseRequest, reasoning_split: false })
      .toProviderRequest() as Record<string, unknown>;

    expect(request.reasoning_split).toBe(false);
  });
});
