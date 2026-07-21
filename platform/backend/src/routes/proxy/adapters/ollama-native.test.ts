import { describe, expect, test } from "@/test";
import type { CreateClientOptions, OllamaNative } from "@/types";
import { ollamaNativeAdapterFactory } from "./ollama-native";

type NativeRequest = OllamaNative.Types.ChatRequest;
type NativeResponse = OllamaNative.Types.ChatResponse;

const factory = ollamaNativeAdapterFactory;

function request(overrides: Partial<NativeRequest> = {}): NativeRequest {
  return {
    model: "llama3.2",
    messages: [{ role: "user", content: "hello" }],
    ...overrides,
  } as NativeRequest;
}

function response(overrides: Partial<NativeResponse> = {}): NativeResponse {
  return {
    model: "llama3.2",
    created_at: "2026-07-21T00:00:00Z",
    message: { role: "assistant", content: "hi there" },
    done: true,
    done_reason: "stop",
    prompt_eval_count: 10,
    eval_count: 5,
    ...overrides,
  } as NativeResponse;
}

// A minimal native stream chunk (an NDJSON line's parsed object).
function chunk(overrides: Record<string, unknown> = {}) {
  return {
    model: "llama3.2",
    created_at: "2026-07-21T00:00:00Z",
    message: { role: "assistant", content: "" },
    done: false,
    ...overrides,
  } as OllamaNative.Types.ChatStreamChunk;
}

describe("ollamaNativeAdapterFactory — identity", () => {
  test("declares the native provider + discriminator", () => {
    expect(factory.provider).toBe("ollama-native");
    expect(factory.interactionType).toBe("ollama-native:chat");
    expect(factory.spanName).toBe("chat");
  });

  test("extractApiKey returns the authorization value as-is", () => {
    expect(factory.extractApiKey({ authorization: "secret" })).toBe("secret");
    expect(factory.extractApiKey({})).toBeUndefined();
  });
});

describe("request adapter", () => {
  test("reads model, streaming flag, and tools", () => {
    const adapter = factory.createRequestAdapter(
      request({
        stream: true,
        tools: [
          {
            type: "function",
            function: {
              name: "read_file",
              description: "reads a file",
              parameters: { type: "object", properties: {} },
            },
          },
        ],
      }),
    );
    expect(adapter.getModel()).toBe("llama3.2");
    expect(adapter.isStreaming()).toBe(true);
    expect(adapter.hasTools()).toBe(true);
    expect(adapter.getTools()).toEqual([
      {
        name: "read_file",
        description: "reads a file",
        inputSchema: { type: "object", properties: {} },
      },
    ]);
  });

  test("maps tool-result messages to common tool results with resolved name", () => {
    const adapter = factory.createRequestAdapter(
      request({
        messages: [
          { role: "user", content: "run it" },
          {
            role: "assistant",
            content: "",
            tool_calls: [
              {
                id: "call_1",
                function: { name: "read_file", arguments: '{"path":"a"}' },
              },
            ],
          },
          {
            role: "tool",
            tool_call_id: "call_1",
            content: '{"ok":true}',
          },
        ],
      }),
    );
    const results = adapter.getToolResults();
    expect(results).toEqual([
      {
        id: "call_1",
        name: "read_file",
        content: { ok: true },
        isError: false,
      },
    ]);
    // Common-format messages expose the tool call on the tool message too.
    const toolMsg = adapter.getMessages().find((m) => m.role === "tool");
    expect(toolMsg?.toolCalls?.[0]?.name).toBe("read_file");
  });

  test("toProviderRequest applies tool-result updates (TOON / trusted-data)", () => {
    const adapter = factory.createRequestAdapter(
      request({
        messages: [
          {
            role: "assistant",
            content: "",
            tool_calls: [
              { id: "c1", function: { name: "t", arguments: "{}" } },
            ],
          },
          { role: "tool", tool_call_id: "c1", content: "original" },
        ],
      }),
    );
    adapter.applyToolResultUpdates({ c1: "compressed" });
    const out = adapter.toProviderRequest();
    const toolMsg = out.messages.find((m) => m.role === "tool");
    expect(toolMsg?.content).toBe("compressed");
  });
});

describe("response adapter", () => {
  test("extracts text, usage, and finish reason", () => {
    const adapter = factory.createResponseAdapter(response());
    expect(adapter.getText()).toBe("hi there");
    expect(adapter.hasToolCalls()).toBe(false);
    expect(adapter.getUsage()).toEqual({
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
    expect(adapter.getFinishReasons()).toEqual(["stop"]);
  });

  test("extracts native tool calls with object arguments", () => {
    const adapter = factory.createResponseAdapter(
      response({
        message: {
          role: "assistant",
          content: "",
          tool_calls: [
            {
              id: "call_9",
              function: { name: "search", arguments: { q: "cats" } },
            },
          ],
        },
        done_reason: "stop",
      }),
    );
    expect(adapter.hasToolCalls()).toBe(true);
    expect(adapter.getToolCalls()).toEqual([
      { id: "call_9", name: "search", arguments: { q: "cats" } },
    ]);
    // A response carrying tool calls reports the tool_calls finish reason.
    expect(adapter.getFinishReasons()).toEqual(["tool_calls"]);
  });

  test("toRefusalResponse replaces the message with the refusal text", () => {
    const adapter = factory.createResponseAdapter(response());
    const refusal = adapter.toRefusalResponse(
      "blocked",
      "Not allowed",
    ) as NativeResponse;
    expect(refusal.message.content).toBe("Not allowed");
    expect(refusal.message.tool_calls).toBeUndefined();
    expect(refusal.done).toBe(true);
    expect(refusal.done_reason).toBe("stop");
  });
});

describe("stream adapter", () => {
  test("streams NDJSON headers (not SSE)", () => {
    const adapter = factory.createStreamAdapter();
    expect(adapter.getSSEHeaders()["Content-Type"]).toBe(
      "application/x-ndjson",
    );
  });

  test("streams text deltas immediately and accumulates text", () => {
    const adapter = factory.createStreamAdapter();
    const r1 = adapter.processChunk(
      chunk({ message: { role: "assistant", content: "Hel" } }),
    );
    const r2 = adapter.processChunk(
      chunk({ message: { role: "assistant", content: "lo" } }),
    );
    expect(r1.sseData).toBe(
      `${JSON.stringify(chunk({ message: { role: "assistant", content: "Hel" } }))}\n`,
    );
    expect(r1.isToolCallChunk).toBe(false);
    expect(r2.sseData).toContain('"content":"lo"');
    expect(adapter.state.text).toBe("Hello");
  });

  test("buffers tool-call chunks and replays them via getRawToolCallEvents", () => {
    const adapter = factory.createStreamAdapter();
    const toolChunk = chunk({
      message: {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: "c1",
            function: { name: "read_file", arguments: { path: "x" } },
          },
        ],
      },
    });
    const result = adapter.processChunk(toolChunk);
    // Buffered, not streamed inline.
    expect(result.isToolCallChunk).toBe(true);
    expect(result.sseData).toBeNull();
    expect(adapter.state.toolCalls).toEqual([
      { id: "c1", name: "read_file", arguments: '{"path":"x"}' },
    ]);
    const replayed = adapter.getRawToolCallEvents();
    expect(replayed).toHaveLength(1);
    expect(replayed[0]).toContain("read_file");
  });

  test("captures usage on the done chunk and emits a final done line", () => {
    const adapter = factory.createStreamAdapter();
    adapter.processChunk(
      chunk({ message: { role: "assistant", content: "hi" } }),
    );
    const done = adapter.processChunk(
      chunk({
        message: { role: "assistant", content: "" },
        done: true,
        done_reason: "stop",
        prompt_eval_count: 7,
        eval_count: 3,
      }),
    );
    expect(done.isFinal).toBe(true);
    expect(done.sseData).toBeNull();
    expect(adapter.state.usage).toEqual({
      inputTokens: 7,
      outputTokens: 3,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
    const end = JSON.parse(adapter.formatEndSSE().trim());
    expect(end.done).toBe(true);
    expect(end.done_reason).toBe("stop");
    expect(end.prompt_eval_count).toBe(7);
    expect(end.eval_count).toBe(3);
  });

  test("toProviderResponse reconstructs the full native response with tool calls", () => {
    const adapter = factory.createStreamAdapter();
    adapter.processChunk(
      chunk({
        message: {
          role: "assistant",
          content: "",
          tool_calls: [
            { id: "c1", function: { name: "t", arguments: { a: 1 } } },
          ],
        },
      }),
    );
    adapter.processChunk(
      chunk({
        done: true,
        done_reason: "stop",
        prompt_eval_count: 2,
        eval_count: 1,
      }),
    );
    const full = adapter.toProviderResponse();
    expect(full.done).toBe(true);
    expect(full.message.tool_calls).toEqual([
      { id: "c1", function: { name: "t", arguments: { a: 1 } } },
    ]);
    expect(full.prompt_eval_count).toBe(2);
    expect(full.eval_count).toBe(1);
  });

  test("formatCompleteTextSSE marks a refusal replacement ending in stop", () => {
    const adapter = factory.createStreamAdapter();
    adapter.processChunk(
      chunk({
        message: {
          role: "assistant",
          content: "",
          tool_calls: [{ id: "c1", function: { name: "t", arguments: {} } }],
        },
      }),
    );
    const events = adapter.formatCompleteTextSSE("Blocked by policy");
    expect(events[0]).toContain("Blocked by policy");
    const end = JSON.parse(adapter.formatEndSSE().trim());
    expect(end.done_reason).toBe("stop");
    // The refusal drops the blocked tool calls from the persisted response.
    expect(adapter.toProviderResponse().message.tool_calls).toBeUndefined();
    expect(adapter.toProviderResponse().message.content).toBe(
      "Blocked by policy",
    );
  });
});

describe("execute / executeStream — upstream transport", () => {
  function client(fetchImpl: typeof fetch, baseUrl = "http://ollama.test") {
    return {
      baseUrl,
      fetch: fetchImpl,
      headers: undefined,
      apiKey: undefined,
      abortSignal: undefined,
    };
  }

  test("createClient strips a /v1 suffix from the upstream base URL", () => {
    const created = factory.createClient(undefined, {
      baseUrl: "http://ollama.test/v1",
      source: "chat",
    } as CreateClientOptions) as { baseUrl: string };
    expect(created.baseUrl).toBe("http://ollama.test");
  });

  test("execute POSTs /api/chat with stream:false and returns the native response", async () => {
    let capturedUrl = "";
    let capturedBody: Record<string, unknown> = {};
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      capturedUrl = String(url);
      capturedBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify(response()), { status: 200 });
    }) as unknown as typeof fetch;

    const result = await factory.execute(client(fetchImpl), request());
    expect(capturedUrl).toBe("http://ollama.test/api/chat");
    expect(capturedBody.stream).toBe(false);
    expect(result.message.content).toBe("hi there");
  });

  test("executeStream reads NDJSON lines and yields parsed chunks", async () => {
    const ndjson =
      `${JSON.stringify(chunk({ message: { role: "assistant", content: "a" } }))}\n` +
      `${JSON.stringify(chunk({ done: true, done_reason: "stop", eval_count: 1 }))}\n`;
    const fetchImpl = (async () =>
      new Response(ndjson, { status: 200 })) as unknown as typeof fetch;

    const stream = await factory.executeStream(
      client(fetchImpl),
      request({ stream: true }),
    );
    const chunks = [];
    for await (const c of stream) chunks.push(c);
    expect(chunks).toHaveLength(2);
    expect(chunks[0].message.content).toBe("a");
    expect(chunks[1].done).toBe(true);
  });

  test("execute surfaces an upstream error body as the error message", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ error: "model not found" }), {
        status: 404,
      })) as unknown as typeof fetch;
    await expect(factory.execute(client(fetchImpl), request())).rejects.toThrow(
      "model not found",
    );
  });

  test("extractErrorMessage reads Ollama's { error } shape", () => {
    expect(factory.extractErrorMessage({ error: "boom" })).toBe("boom");
    expect(factory.extractErrorMessage(new Error("net"))).toBe("net");
  });
});
