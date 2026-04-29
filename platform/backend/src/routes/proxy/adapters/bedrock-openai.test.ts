import type { ConverseStreamOutput } from "@aws-sdk/client-bedrock-runtime";
import { describe, expect, test } from "@/test";
import type { Bedrock } from "@/types";
import { makeBedrockOpenaiAdapterFactory } from "./bedrock-openai";
import type { OpenaiContext } from "./bedrock-openai-translator";

const ctx: OpenaiContext = {
  chatcmplId: "chatcmpl-abc",
  createdUnix: 1_700_000_000,
  requestedModel: "zai.glm-4.7",
  includeUsageInStream: false,
};

function decode(bytes: Uint8Array | string | null): string {
  if (bytes == null) return "";
  if (typeof bytes === "string") return bytes;
  return new TextDecoder().decode(bytes);
}

function parseSse(bytes: Uint8Array | string | null): unknown[] {
  const text = decode(bytes);
  const out: unknown[] = [];
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("data:")) continue;
    const payload = t.slice(5).trim();
    if (payload === "[DONE]") out.push("[DONE]");
    else if (payload) out.push(JSON.parse(payload));
  }
  return out;
}

describe("BedrockOpenai response adapter", () => {
  test("getOriginalResponse returns OpenAI chat.completion shape", () => {
    const factory = makeBedrockOpenaiAdapterFactory(ctx);
    const resp = factory.createResponseAdapter({
      output: {
        message: {
          role: "assistant",
          content: [{ text: "hi" }],
        },
      },
      stopReason: "end_turn",
      usage: { inputTokens: 3, outputTokens: 2 },
    } as Bedrock.Types.ConverseResponse);

    // biome-ignore lint/suspicious/noExplicitAny: crossing typed boundary
    const original = resp.getOriginalResponse() as any;
    expect(original.id).toBe("chatcmpl-abc");
    expect(original.object).toBe("chat.completion");
    expect(original.model).toBe("zai.glm-4.7");
    expect(original.choices[0].message.content).toBe("hi");
    expect(original.choices[0].finish_reason).toBe("stop");
    expect(original.usage).toEqual({
      prompt_tokens: 3,
      completion_tokens: 2,
      total_tokens: 5,
    });
  });

  test("getLoggedResponse returns the inner Converse shape (for interaction log)", () => {
    const factory = makeBedrockOpenaiAdapterFactory(ctx);
    const converse = {
      output: {
        message: {
          role: "assistant" as const,
          content: [{ text: "hi" }],
        },
      },
      stopReason: "end_turn" as const,
      usage: { inputTokens: 3, outputTokens: 2 },
    };
    const resp = factory.createResponseAdapter(
      converse as Bedrock.Types.ConverseResponse,
    );

    const logged = resp.getLoggedResponse?.();
    expect(logged).toBe(converse);
    // And the wire response is still OpenAI-shaped — the two must diverge.
    // biome-ignore lint/suspicious/noExplicitAny: crossing typed boundary
    expect((resp.getOriginalResponse() as any).object).toBe("chat.completion");
  });

  test("tool_use response → OpenAI tool_calls + finish_reason tool_calls", () => {
    const factory = makeBedrockOpenaiAdapterFactory(ctx);
    const resp = factory.createResponseAdapter({
      output: {
        message: {
          role: "assistant",
          content: [
            {
              toolUse: {
                toolUseId: "t_1",
                name: "get_weather",
                input: { city: "SF" },
              },
            },
          ],
        },
      },
      stopReason: "tool_use",
      usage: { inputTokens: 5, outputTokens: 3 },
    } as Bedrock.Types.ConverseResponse);

    // biome-ignore lint/suspicious/noExplicitAny: crossing typed boundary
    const original = resp.getOriginalResponse() as any;
    expect(original.choices[0].finish_reason).toBe("tool_calls");
    expect(original.choices[0].message.tool_calls).toEqual([
      {
        id: "t_1",
        type: "function",
        function: { name: "get_weather", arguments: '{"city":"SF"}' },
      },
    ]);
  });

  test("toRefusalResponse emits OpenAI-shaped refusal with finish_reason stop", () => {
    const factory = makeBedrockOpenaiAdapterFactory(ctx);
    const resp = factory.createResponseAdapter({
      output: {
        message: {
          role: "assistant",
          content: [{ text: "should be replaced" }],
        },
      },
      stopReason: "end_turn",
      usage: { inputTokens: 1, outputTokens: 1 },
    } as Bedrock.Types.ConverseResponse);

    const refusal = resp.toRefusalResponse(
      "blocked by policy",
      "Sorry, that tool is disabled.",
      // biome-ignore lint/suspicious/noExplicitAny: crossing typed boundary
    ) as any;
    expect(refusal.object).toBe("chat.completion");
    expect(refusal.choices[0].finish_reason).toBe("stop");
    expect(refusal.choices[0].message.content).toBe(
      "Sorry, that tool is disabled.",
    );
  });

  test("delegates telemetry reads to inner (Converse-shape tool call names)", () => {
    const factory = makeBedrockOpenaiAdapterFactory(ctx);
    const resp = factory.createResponseAdapter({
      output: {
        message: {
          role: "assistant",
          content: [
            {
              toolUse: {
                toolUseId: "t_1",
                name: "do_thing",
                input: { k: 1 },
              },
            },
          ],
        },
      },
      stopReason: "tool_use",
      usage: { inputTokens: 1, outputTokens: 1 },
    } as Bedrock.Types.ConverseResponse);

    const calls = resp.getToolCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe("do_thing");
    expect(resp.hasToolCalls()).toBe(true);
    expect(resp.getUsage()).toEqual({ inputTokens: 1, outputTokens: 1 });
    expect(resp.getFinishReasons()).toEqual(["tool_use"]);
  });
});

describe("BedrockOpenai stream adapter — wire output", () => {
  function chunk<T extends ConverseStreamOutput>(c: T): T {
    return c;
  }

  test("text delta chunks → OpenAI content delta SSE", () => {
    const factory = makeBedrockOpenaiAdapterFactory(ctx);
    const stream = factory.createStreamAdapter({
      modelId: "zai.glm-4.7",
      messages: [],
    });

    const a = stream.processChunk(
      chunk({ messageStart: { role: "assistant" } }),
    );
    expect(a.isToolCallChunk).toBe(false);
    expect(parseSse(a.sseData)).toEqual([
      {
        id: "chatcmpl-abc",
        object: "chat.completion.chunk",
        created: 1_700_000_000,
        model: "zai.glm-4.7",
        choices: [
          { index: 0, delta: { role: "assistant" }, finish_reason: null },
        ],
      },
    ]);

    const b = stream.processChunk(
      chunk({
        contentBlockDelta: { contentBlockIndex: 0, delta: { text: "Hi" } },
      }),
    );
    expect(parseSse(b.sseData)).toEqual([
      {
        id: "chatcmpl-abc",
        object: "chat.completion.chunk",
        created: 1_700_000_000,
        model: "zai.glm-4.7",
        choices: [{ index: 0, delta: { content: "Hi" }, finish_reason: null }],
      },
    ]);
  });

  test("tool_use events are buffered (isToolCallChunk=true, no sseData)", () => {
    const factory = makeBedrockOpenaiAdapterFactory(ctx);
    const stream = factory.createStreamAdapter({
      modelId: "zai.glm-4.7",
      messages: [],
    });

    const r = stream.processChunk(
      chunk({
        contentBlockStart: {
          contentBlockIndex: 1,
          start: { toolUse: { toolUseId: "t_1", name: "f" } },
        },
      }),
    );
    expect(r.isToolCallChunk).toBe(true);
    expect(r.sseData).toBeNull();

    stream.processChunk(
      chunk({
        contentBlockDelta: {
          contentBlockIndex: 1,
          delta: { toolUse: { input: "{}" } },
        },
      }),
    );

    // state must still reflect the tool call (via inner's state machine)
    expect(stream.state.toolCalls).toHaveLength(1);
    expect(stream.state.toolCalls[0].name).toBe("f");

    // getRawToolCallEvents returns OpenAI-shape SSE bytes on demand
    const events = stream.getRawToolCallEvents();
    expect(events).toHaveLength(2);
    const openEvent = parseSse(events[0]);
    // biome-ignore lint/suspicious/noExplicitAny: inspection
    expect((openEvent[0] as any).choices[0].delta.tool_calls[0]).toMatchObject({
      index: 0,
      id: "t_1",
      type: "function",
      function: { name: "f", arguments: "" },
    });
    const argEvent = parseSse(events[1]);
    // biome-ignore lint/suspicious/noExplicitAny: inspection
    expect((argEvent[0] as any).choices[0].delta.tool_calls[0]).toMatchObject({
      index: 0,
      function: { arguments: "{}" },
    });
  });

  test("messageStop holds back finish chunk; formatEndSSE emits it + [DONE]", () => {
    const factory = makeBedrockOpenaiAdapterFactory(ctx);
    const stream = factory.createStreamAdapter({
      modelId: "zai.glm-4.7",
      messages: [],
    });

    const stop = stream.processChunk(
      chunk({ messageStop: { stopReason: "end_turn" } }),
    );
    expect(stop.sseData).toBeNull();

    const end = stream.formatEndSSE();
    const events = parseSse(end);
    expect(events).toHaveLength(2);
    // biome-ignore lint/suspicious/noExplicitAny: inspection
    expect((events[0] as any).choices[0].finish_reason).toBe("stop");
    expect(events[1]).toBe("[DONE]");
  });

  test("formatCompleteTextSSE returns refusal chunks (role + content + finish stop)", () => {
    const factory = makeBedrockOpenaiAdapterFactory(ctx);
    const stream = factory.createStreamAdapter({
      modelId: "zai.glm-4.7",
      messages: [],
    });
    // stash a tool_use finish that should be DISCARDED by refusal
    stream.processChunk(chunk({ messageStop: { stopReason: "tool_use" } }));

    const events = stream.formatCompleteTextSSE("Blocked");
    expect(events).toHaveLength(3);
    const decoded = events.map((b) => parseSse(b)[0]) as unknown[];
    // biome-ignore lint/suspicious/noExplicitAny: inspection
    const [role, content, finish] = decoded as any[];
    expect(role.choices[0]).toEqual({
      index: 0,
      delta: { role: "assistant" },
      finish_reason: null,
    });
    expect(content.choices[0].delta.content).toBe("Blocked");
    expect(finish.choices[0].finish_reason).toBe("stop");

    // formatEndSSE should NOT re-emit the stashed tool_use finish
    const endEvents = parseSse(stream.formatEndSSE());
    expect(endEvents).toEqual(["[DONE]"]);
  });

  test("getSSEHeaders returns OpenAI event-stream headers", () => {
    const factory = makeBedrockOpenaiAdapterFactory(ctx);
    const stream = factory.createStreamAdapter({
      modelId: "zai.glm-4.7",
      messages: [],
    });
    expect(stream.getSSEHeaders()).toEqual({
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
  });

  // toProviderResponse is the log-storage hook (see LLMStreamAdapter doc) —
  // not a wire-serialization method. Under the bedrock-openai adapter it
  // intentionally returns Converse shape so the interaction row matches the
  // `bedrock:converse` type that the logs UI parser keys off. Client wire
  // bytes stay OpenAI-shaped via processChunk/formatEndSSE — this test only
  // covers what gets persisted.
  test("toProviderResponse reconstructs Converse shape from state (for log)", () => {
    const factory = makeBedrockOpenaiAdapterFactory(ctx);
    const stream = factory.createStreamAdapter({
      modelId: "zai.glm-4.7",
      messages: [],
    });
    stream.processChunk(chunk({ messageStart: { role: "assistant" } }));
    stream.processChunk(
      chunk({
        contentBlockDelta: { contentBlockIndex: 0, delta: { text: "Hello" } },
      }),
    );
    stream.processChunk(chunk({ messageStop: { stopReason: "end_turn" } }));
    stream.processChunk(
      chunk({
        metadata: {
          usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
          metrics: { latencyMs: 0 },
        },
      }),
    );

    // biome-ignore lint/suspicious/noExplicitAny: crossing typed boundary
    const resp = stream.toProviderResponse() as any;
    expect(resp.output.message.role).toBe("assistant");
    expect(resp.output.message.content).toEqual([{ text: "Hello" }]);
    expect(resp.stopReason).toBe("end_turn");
    expect(resp.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
  });
});

describe("BedrockOpenai factory — metadata", () => {
  test("provider identifier stays bedrock so virtual keys resolve", () => {
    const factory = makeBedrockOpenaiAdapterFactory(ctx);
    expect(factory.provider).toBe("bedrock");
  });

  test("execute / executeStream / extractApiKey delegate to bedrockAdapterFactory", () => {
    const factory = makeBedrockOpenaiAdapterFactory(ctx);
    // delegation sanity — function identity check
    expect(typeof factory.execute).toBe("function");
    expect(typeof factory.executeStream).toBe("function");
    expect(typeof factory.extractApiKey).toBe("function");
    expect(typeof factory.createClient).toBe("function");

    // extractApiKey still strips "Bearer "
    expect(factory.extractApiKey({ authorization: "Bearer abc" })).toBe("abc");
    expect(
      factory.extractApiKey({} as Bedrock.Types.ConverseHeaders),
    ).toBeUndefined();
  });
});
