import { describe, expect, test } from "@/test";
import { buildUnifiedResponsesAdapter } from "./unified-responses";

const STUB_INNER = {
  provider: "groq" as const,
  interactionType: "groq:chatCompletions" as const,
  spanName: "chat" as const,
  createRequestAdapter: () => ({}) as never,
  createResponseAdapter: () => ({}) as never,
  createStreamAdapter: () => ({}) as never,
  extractApiKey: () => undefined,
  getBaseUrl: () => undefined,
  createClient: () => ({}),
  execute: async () => ({
    id: "chatcmpl-stub",
    object: "chat.completion" as const,
    created: 1_700_000_000,
    model: "llama-3.1-8b-instant",
    choices: [
      {
        index: 0,
        message: { role: "assistant" as const, content: "stub response" },
        finish_reason: "stop" as const,
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  }),
  executeStream: async () => (async function* () {})(),
  extractErrorMessage: (e: unknown) => String(e),
};

function makeAdapter(input: unknown, opts: Record<string, unknown> = {}) {
  const adapter = buildUnifiedResponsesAdapter(STUB_INNER as never);
  return adapter.createRequestAdapter({
    model: "llama-3.1-8b-instant",
    input,
    ...opts,
  } as never);
}

describe("getMessages() — string input", () => {
  test("converts plain string input to a single user message", () => {
    const adapter = makeAdapter("Hello world");
    expect(adapter.getMessages()).toEqual([
      { role: "user", content: "Hello world" },
    ]);
  });

  test("prepends system message when instructions are provided", () => {
    const adapter = makeAdapter("Hi", { instructions: "You are a pirate." });
    expect(adapter.getMessages()).toEqual([
      { role: "system", content: "You are a pirate." },
      { role: "user", content: "Hi" },
    ]);
  });
});

describe("getMessages() — typeless input items (no type field)", () => {
  test("handles { role, content: string } without type field", () => {
    const adapter = makeAdapter([{ role: "user", content: "Hello from n8n" }]);
    expect(adapter.getMessages()).toEqual([
      { role: "user", content: "Hello from n8n" },
    ]);
  });

  test("handles multi-turn { role, content } conversation", () => {
    const adapter = makeAdapter([
      { role: "user", content: "My name is Alice." },
      { role: "assistant", content: "Hello Alice!" },
      { role: "user", content: "What is my name?" },
    ]);
    expect(adapter.getMessages()).toEqual([
      { role: "user", content: "My name is Alice." },
      { role: "assistant", content: "Hello Alice!" },
      { role: "user", content: "What is my name?" },
    ]);
  });

  test("defaults role to 'user' when role is present but type is missing", () => {
    const adapter = makeAdapter([
      { role: "user", content: "plain message, no type field" },
    ]);
    const msgs = adapter.getMessages();
    expect(msgs[0].role).toBe("user");
    expect(msgs[0].content).toBe("plain message, no type field");
  });
});

describe("getMessages() — standard Responses API format (type: message)", () => {
  test("handles { type: 'message', role, content: string }", () => {
    const adapter = makeAdapter([
      { type: "message", role: "user", content: "Standard format" },
    ]);
    expect(adapter.getMessages()).toEqual([
      { role: "user", content: "Standard format" },
    ]);
  });

  test("handles content as input_text array part", () => {
    const adapter = makeAdapter([
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Input from parts" }],
      },
    ]);
    expect(adapter.getMessages()).toEqual([
      { role: "user", content: "Input from parts" },
    ]);
  });

  test("handles content as output_text array part (assistant history)", () => {
    const adapter = makeAdapter([
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "What did I say?" }],
      },
    ]);
    const msgs = adapter.getMessages();
    expect(msgs[0].content).toBe("What did I say?");
  });

  test("joins multiple content parts with newline", () => {
    const adapter = makeAdapter([
      {
        type: "message",
        role: "user",
        content: [
          { type: "input_text", text: "Part one" },
          { type: "input_text", text: "Part two" },
        ],
      },
    ]);
    expect(adapter.getMessages()[0].content).toBe("Part one\nPart two");
  });
});

describe("getToolResults()", () => {
  test("extracts function_call_output items as CommonToolResult", () => {
    const adapter = makeAdapter([
      { role: "user", content: "Call get_weather" },
      {
        type: "function_call_output",
        call_id: "call_abc123",
        output: '{"temperature": 22, "unit": "celsius"}',
      },
    ]);
    const msgs = adapter.getMessages();
    expect(msgs).toHaveLength(1);
    expect(msgs[0].role).toBe("user");

    const results = adapter.getToolResults();
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe("call_abc123");
    expect(results[0].content).toBe('{"temperature": 22, "unit": "celsius"}');
    expect(results[0].isError).toBe(false);
  });

  test("serializes non-string output to JSON string", () => {
    const adapter = makeAdapter([
      {
        type: "function_call_output",
        call_id: "call_xyz",
        output: { result: 42 },
      },
    ]);
    const results = adapter.getToolResults();
    expect(results[0].content).toBe('{"result":42}');
  });

  test("returns empty array when no tool outputs in input", () => {
    const adapter = makeAdapter([{ role: "user", content: "no tools" }]);
    expect(adapter.getToolResults()).toEqual([]);
  });
});

describe("getTools()", () => {
  test("returns empty array when no tools provided", () => {
    expect(makeAdapter("hello").getTools()).toEqual([]);
  });

  test("maps function tool to CommonMcpToolDefinition", () => {
    const adapter = makeAdapter("use tool", {
      tools: [
        {
          type: "function",
          name: "read_file",
          description: "Reads a file",
          parameters: {
            type: "object",
            properties: { path: { type: "string" } },
            required: ["path"],
          },
        },
      ],
    });
    expect(adapter.getTools()).toEqual([
      {
        name: "read_file",
        description: "Reads a file",
        inputSchema: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
        },
      },
    ]);
  });

  test("ignores non-function tool types", () => {
    const adapter = makeAdapter("use tool", {
      tools: [
        { type: "web_search" }, // not a function — must be ignored
        { type: "function", name: "my_tool", parameters: {} },
      ],
    });
    expect(adapter.getTools()).toHaveLength(1);
    expect(adapter.getTools()[0].name).toBe("my_tool");
  });
});

describe("isStreaming()", () => {
  test("returns true when stream: true", () => {
    expect(makeAdapter("hi", { stream: true }).isStreaming()).toBe(true);
  });

  test("returns false when stream: false", () => {
    expect(makeAdapter("hi", { stream: false }).isStreaming()).toBe(false);
  });

  test("returns false when stream is absent", () => {
    expect(makeAdapter("hi").isStreaming()).toBe(false);
  });
});

describe("getModel() / setModel()", () => {
  test("returns original model before setModel()", () => {
    const adapter = makeAdapter("hi");
    expect(adapter.getModel()).toBe("llama-3.1-8b-instant");
  });

  test("returns overridden model after setModel()", () => {
    const adapter = makeAdapter("hi");
    adapter.setModel("llama-3.3-70b-versatile");
    expect(adapter.getModel()).toBe("llama-3.3-70b-versatile");
  });
});

describe("execute() round-trip", () => {
  test("translates Responses API request → Chat Completions → back to Responses API", async () => {
    const adapter = buildUnifiedResponsesAdapter(STUB_INNER as never);
    const result = await adapter.execute(
      {} as never,
      {
        model: "llama-3.1-8b-instant",
        input: "Hello",
        stream: false,
      } as never,
    );

    expect(result.object).toBe("response");
    expect(result.status).toBe("completed");
    expect(Array.isArray(result.output)).toBe(true);
    const output = result.output as unknown as Array<Record<string, unknown>>;
    expect(output[0].type).toBe("message");
    expect(output[0].role).toBe("assistant");
    const content = output[0].content as Array<Record<string, unknown>>;
    expect(content[0].type).toBe("output_text");
    expect(content[0].text).toBe("stub response");
  });

  test("maps usage from Chat Completions to Responses API format", async () => {
    const adapter = buildUnifiedResponsesAdapter(STUB_INNER as never);
    const result = await adapter.execute(
      {} as never,
      {
        model: "llama-3.1-8b-instant",
        input: "Hello",
        stream: false,
      } as never,
    );

    const usage = result.usage as Record<string, number> | undefined;
    expect(usage?.input_tokens).toBe(10);
    expect(usage?.output_tokens).toBe(5);
    expect(usage?.total_tokens).toBe(15);
  });

  test("id is prefixed with resp_", async () => {
    const adapter = buildUnifiedResponsesAdapter(STUB_INNER as never);
    const result = await adapter.execute(
      {} as never,
      {
        model: "llama-3.1-8b-instant",
        input: "Hi",
        stream: false,
      } as never,
    );
    expect(typeof result.id).toBe("string");
    expect(result.id.startsWith("resp_")).toBe(true);
  });
});
