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
    expect(factory.extractApiKey({ authorization: undefined })).toBeUndefined();
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
    const end = JSON.parse(String(adapter.formatEndSSE()).trim());
    expect(end.done).toBe(true);
    expect(end.done_reason).toBe("stop");
    expect(end.prompt_eval_count).toBe(7);
    expect(end.eval_count).toBe(3);
  });

  test("every tool call in one chunk is recorded, not just the last", () => {
    // Ollama delivers parallel calls in a single `tool_calls` array. The proxy
    // handler decides buffer-vs-stream from the accumulated list, so a call
    // dropped here would never be policy-checked.
    const adapter = factory.createStreamAdapter();
    adapter.processChunk(
      chunk({
        message: {
          role: "assistant",
          content: "",
          tool_calls: [
            { id: "c1", function: { name: "dangerous", arguments: { a: 1 } } },
            { id: "c2", function: { name: "safe", arguments: { b: 2 } } },
          ],
        },
      }),
    );
    expect(adapter.state.toolCalls.map((c) => c.name)).toEqual([
      "dangerous",
      "safe",
    ]);
  });

  test("assistant text alongside a tool call still reaches state.text", () => {
    // The client sees this text inside the replayed raw line; state.text is
    // what the persisted interaction and the span record.
    const adapter = factory.createStreamAdapter();
    adapter.processChunk(
      chunk({
        message: {
          role: "assistant",
          content: "let me look that up",
          tool_calls: [{ id: "c1", function: { name: "t", arguments: {} } }],
        },
      }),
    );
    expect(adapter.state.text).toBe("let me look that up");
  });

  test("a chunk carrying both tool calls and done is final and keeps its usage", () => {
    const adapter = factory.createStreamAdapter();
    const result = adapter.processChunk(
      chunk({
        message: {
          role: "assistant",
          content: "",
          tool_calls: [{ id: "c1", function: { name: "t", arguments: {} } }],
        },
        done: true,
        done_reason: "stop",
        prompt_eval_count: 7,
        eval_count: 3,
      }),
    );
    expect(result.isToolCallChunk).toBe(true);
    expect(result.isFinal).toBe(true);
    expect(adapter.state.usage?.inputTokens).toBe(7);

    // formatEndSSE synthesizes the terminating frame, so the buffered raw line
    // must not carry a second `done: true`.
    const buffered = adapter
      .getRawToolCallEvents()
      .map((line) => JSON.parse(String(line)));
    expect(buffered).toHaveLength(1);
    expect(buffered[0].done).toBe(false);
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
    const end = JSON.parse(String(adapter.formatEndSSE()).trim());
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

  test("an upstream error carries the upstream status, not a bare 500", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ error: "model not found" }), {
        status: 404,
      })) as unknown as typeof fetch;

    // `handleError` reads `.status` to pick the HTTP status; without it every
    // upstream failure collapses to 500 and callers cannot tell a permanent
    // 404 from a retryable 503.
    const error = await factory
      .execute(client(fetchImpl), request())
      .then(() => null)
      .catch((e) => e as Error & { status?: number; error?: unknown });

    expect(error?.status).toBe(404);
    expect(factory.extractErrorMessage(error)).toBe("model not found");
  });

  test("executeStream surfaces the upstream status too", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ error: "overloaded" }), {
        status: 503,
      })) as unknown as typeof fetch;

    const error = await factory
      .executeStream(client(fetchImpl), request({ stream: true }))
      .then(() => null)
      .catch((e) => e as Error & { status?: number });

    expect(error?.status).toBe(503);
  });

  test("a non-JSON upstream body is truncated before it reaches the caller", async () => {
    const leaked = `INTERNAL SERVICE DUMP ${"x".repeat(5000)}`;
    const fetchImpl = (async () =>
      new Response(leaked, { status: 500 })) as unknown as typeof fetch;

    const error = await factory
      .execute(client(fetchImpl), request())
      .then(() => null)
      .catch((e) => e as Error);

    expect(error?.message.length).toBeLessThan(leaked.length);
    expect(error?.message.endsWith("…")).toBe(true);
  });

  describe("upstream URL construction", () => {
    const captureUrl = async (baseUrl: string): Promise<string> => {
      let capturedUrl = "";
      const fetchImpl = (async (url: string) => {
        capturedUrl = String(url);
        return new Response(JSON.stringify(response()), { status: 200 });
      }) as unknown as typeof fetch;
      await factory.execute(client(fetchImpl, baseUrl), request());
      return capturedUrl;
    };

    test("a base URL with a trailing query cannot relocate the request path", async () => {
      expect(await captureUrl("http://ollama.test/base?token=abc")).toBe(
        "http://ollama.test/base/api/chat",
      );
    });

    test("a path prefix on the base URL is preserved", async () => {
      // An Ollama published behind a reverse proxy at a path prefix must not
      // have the request — and its bearer token — sent to the host root.
      expect(await captureUrl("https://gw.example.com/ollama")).toBe(
        "https://gw.example.com/ollama/api/chat",
      );
    });

    test("a trailing slash does not double up the path separator", async () => {
      expect(await captureUrl("https://gw.example.com/ollama/")).toBe(
        "https://gw.example.com/ollama/api/chat",
      );
    });

    test("a bare origin still reaches /api/chat", async () => {
      expect(await captureUrl("http://localhost:11434")).toBe(
        "http://localhost:11434/api/chat",
      );
    });
  });

  test("iterateNdjson reassembles a JSON object split across reads", async () => {
    const line = JSON.stringify(
      chunk({ message: { role: "assistant", content: "split" } }),
    );
    const half = Math.floor(line.length / 2);
    const encoder = new TextEncoder();
    // The single-string fixtures elsewhere never exercise the buffer/indexOf
    // loop, so a chunk boundary mid-object would go unnoticed.
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(line.slice(0, half)));
        controller.enqueue(encoder.encode(`${line.slice(half)}\n`));
        controller.close();
      },
    });
    const fetchImpl = (async () =>
      new Response(body, { status: 200 })) as unknown as typeof fetch;

    const stream = await factory.executeStream(
      client(fetchImpl),
      request({ stream: true }),
    );
    const chunks = [];
    for await (const c of stream) chunks.push(c);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].message.content).toBe("split");
  });
});

describe("trusted-data correlation on the native wire (no ids)", () => {
  // Ollama's own clients send `tool_name` and no ids at all. Every fixture in
  // the suites above supplies explicit ids, which is exactly how this shape
  // went untested.
  const nativeToolTurn = () =>
    request({
      messages: [
        { role: "user", content: "fetch it" },
        {
          role: "assistant",
          content: "",
          tool_calls: [
            { function: { name: "fetch_url", arguments: { url: "u" } } },
          ],
        },
        {
          role: "tool",
          tool_name: "fetch_url",
          content: "<attacker-controlled page>",
        },
      ],
    } as Partial<NativeRequest>);

  test("getMessages surfaces a tool call for an id-less tool result", () => {
    const adapter = factory.createRequestAdapter(nativeToolTurn());
    const toolMessage = adapter.getMessages().find((m) => m.role === "tool");

    // A missing tool call here reads as "no tool calls in this context", which
    // evaluateIfContextIsTrusted treats as trusted — disabling trusted-data
    // policies and dual-LLM sanitization with no other signal.
    expect(toolMessage?.toolCalls).toHaveLength(1);
    expect(toolMessage?.toolCalls?.[0].name).toBe("fetch_url");
    expect(toolMessage?.toolCalls?.[0].content).toBe(
      "<attacker-controlled page>",
    );
  });

  test("a tool result with neither an id nor a name still surfaces a tool call", () => {
    const adapter = factory.createRequestAdapter(
      request({
        messages: [
          { role: "user", content: "hi" },
          { role: "tool", content: "untrusted" },
        ],
      } as Partial<NativeRequest>),
    );
    const toolMessage = adapter.getMessages().find((m) => m.role === "tool");

    expect(toolMessage?.toolCalls).toHaveLength(1);
    expect(toolMessage?.toolCalls?.[0].name).toBe("unknown");
  });

  test("getToolResults names an id-less result from tool_name", () => {
    const adapter = factory.createRequestAdapter(nativeToolTurn());
    const results = adapter.getToolResults();

    expect(results).toHaveLength(1);
    expect(results[0].name).toBe("fetch_url");
  });

  test("sanitized content round-trips back onto the id-less message", () => {
    const adapter = factory.createRequestAdapter(nativeToolTurn());
    const toolCallId = adapter.getMessages().find((m) => m.role === "tool")
      ?.toolCalls?.[0].id as string;

    // The guardrails key updates by the id `getMessages` handed out, so the
    // synthesized id has to survive the round trip — otherwise the sanitized
    // result is silently replaced by the untrusted original on the wire.
    adapter.applyToolResultUpdates({ [toolCallId]: "[sanitized]" });

    const forwarded = adapter.toProviderRequest();
    expect(forwarded.messages[2].content).toBe("[sanitized]");
  });

  test("each tool result keeps a distinct id when several share a name", () => {
    const adapter = factory.createRequestAdapter(
      request({
        messages: [
          { role: "user", content: "twice" },
          { role: "tool", tool_name: "search", content: "first" },
          { role: "tool", tool_name: "search", content: "second" },
        ],
      } as Partial<NativeRequest>),
    );
    const ids = adapter.getToolResults().map((r) => r.id);

    expect(new Set(ids).size).toBe(2);

    adapter.applyToolResultUpdates({ [ids[1]]: "[sanitized second]" });
    const forwarded = adapter.toProviderRequest();
    expect(forwarded.messages[1].content).toBe("first");
    expect(forwarded.messages[2].content).toBe("[sanitized second]");
  });
});

describe("streaming details", () => {
  test("formatTextDeltaSSE emits created_at before any upstream chunk", () => {
    const adapter = factory.createStreamAdapter();

    // The dual-LLM progress callbacks run before executeStream. `created_at` is
    // required by the client's stream schema, and JSON.stringify drops
    // undefined keys — so an unset value fails the parse and ends the whole
    // stream with finishReason: "error" on the first progress line.
    const line = JSON.parse(String(adapter.formatTextDeltaSSE("Analyzing…")));
    expect(typeof line.created_at).toBe("string");
    expect(line.message.content).toBe("Analyzing…");
    expect(line.done).toBe(false);
  });

  test("formatEndSSE emits created_at even when no chunk parsed", () => {
    const adapter = factory.createStreamAdapter();
    const line = JSON.parse(String(adapter.formatEndSSE()));
    expect(typeof line.created_at).toBe("string");
    expect(line.done).toBe(true);
  });

  test("a chunk carrying both tool_calls and done keeps usage and stop reason", () => {
    const adapter = factory.createStreamAdapter();
    const result = adapter.processChunk(
      chunk({
        message: {
          role: "assistant",
          content: "",
          tool_calls: [{ function: { name: "search", arguments: {} } }],
        },
        done: true,
        done_reason: "stop",
        prompt_eval_count: 11,
        eval_count: 3,
      }),
    );

    // Nothing in the wire format forbids this pairing; if the tool-call branch
    // returned first the interaction would persist with zero tokens and zero
    // cost, surfacing later as unexplained free requests.
    expect(result.isToolCallChunk).toBe(true);
    expect(adapter.state.usage).toEqual({
      inputTokens: 11,
      outputTokens: 3,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
    expect(adapter.state.stopReason).toBe("stop");
  });

  test("accumulates the thinking field without streaming it as content", () => {
    const adapter = factory.createStreamAdapter();
    adapter.processChunk(
      chunk({ message: { role: "assistant", thinking: "reasoning…" } }),
    );
    adapter.processChunk(
      chunk({ message: { role: "assistant", content: "answer" } }),
    );

    expect(adapter.state.text).toBe("answer");
    expect(adapter.toProviderResponse().message.thinking).toBe("reasoning…");
  });

  test("buffers multiple tool calls arriving in one chunk", () => {
    const adapter = factory.createStreamAdapter();
    adapter.processChunk(
      chunk({
        message: {
          role: "assistant",
          content: "",
          tool_calls: [
            { function: { name: "a", arguments: {} } },
            { function: { name: "b", arguments: {} } },
          ],
        },
      }),
    );

    expect(adapter.state.toolCalls.map((c) => c.name)).toEqual(["a", "b"]);
  });

  test("streams by default when the request omits `stream`", () => {
    // Ollama's `stream` is a *bool: nil means true, which is why its own curl
    // examples omit the field and still get NDJSON.
    expect(factory.createRequestAdapter(request()).isStreaming()).toBe(true);
    expect(
      factory.createRequestAdapter(request({ stream: false })).isStreaming(),
    ).toBe(false);
    expect(
      factory.createRequestAdapter(request({ stream: true })).isStreaming(),
    ).toBe(true);
  });

  test("mid-stream errors are framed as NDJSON, not SSE", () => {
    const frame = factory.formatStreamErrorFrame?.({
      type: "error",
      error: { message: "upstream died" },
    });

    // An `event: error\ndata: …` frame is not a parseable NDJSON line, so the
    // client would report a parse failure instead of the real cause.
    expect(frame?.startsWith("event:")).toBe(false);
    expect(frame?.endsWith("\n")).toBe(true);
    expect(JSON.parse(String(frame))).toMatchObject({
      type: "error",
      error: { message: "upstream died" },
    });
  });
});
