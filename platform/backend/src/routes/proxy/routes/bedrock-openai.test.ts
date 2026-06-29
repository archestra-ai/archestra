import Fastify, { type FastifyInstance } from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import { vi } from "vitest";
import { afterEach, describe, expect, test } from "@/test";
import { bedrockAdapterFactory } from "../adapters/bedrock";
import bedrockOpenaiProxyRoutes from "./bedrock-openai";

async function* asyncIterable<T>(items: T[]): AsyncIterable<T> {
  for (const item of items) yield item;
}

function createFastifyApp(): FastifyInstance {
  const app = Fastify().withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  return app;
}

function parseSseChunks(body: string): unknown[] {
  const out: unknown[] = [];
  for (const line of body.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const payload = trimmed.slice(5).trim();
    if (payload === "[DONE]") out.push("[DONE]");
    else if (payload) out.push(JSON.parse(payload));
  }
  return out;
}

const HEADERS = {
  "content-type": "application/json",
  authorization: "Bearer test-key",
  "user-agent": "test-client",
};

describe("/v1/bedrock/openai/chat/completions — non-streaming", () => {
  afterEach(() => vi.restoreAllMocks());

  test("translates OpenAI body → Converse, returns OpenAI chat.completion", async ({
    makeAgent,
  }) => {
    const captured: Record<string, unknown>[] = [];
    vi.spyOn(bedrockAdapterFactory, "createClient").mockImplementation(
      () =>
        ({
          converse: async (modelId: string, req: Record<string, unknown>) => {
            captured.push({ modelId, ...req });
            return {
              $metadata: { requestId: "req_1" },
              output: {
                message: {
                  role: "assistant",
                  content: [{ text: "Hello from Bedrock" }],
                },
              },
              stopReason: "end_turn",
              usage: { inputTokens: 12, outputTokens: 3 },
            };
          },
          converseStream: async () => asyncIterable([]),
        }) as never,
    );

    const app = createFastifyApp();
    await app.register(bedrockOpenaiProxyRoutes);
    const agent = await makeAgent({ name: "bedrock-openai-agent" });

    const response = await app.inject({
      method: "POST",
      url: `/v1/bedrock/openai/${agent.id}/chat/completions`,
      headers: HEADERS,
      payload: {
        model: "zai.glm-4.7",
        messages: [
          { role: "system", content: "be brief" },
          { role: "user", content: "hi" },
        ],
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();

    // OpenAI-shape response
    expect(body.object).toBe("chat.completion");
    expect(body.model).toBe("zai.glm-4.7");
    expect(body.choices).toHaveLength(1);
    expect(body.choices[0].finish_reason).toBe("stop");
    expect(body.choices[0].message.role).toBe("assistant");
    expect(body.choices[0].message.content).toBe("Hello from Bedrock");
    expect(body.usage).toEqual({
      prompt_tokens: 12,
      completion_tokens: 3,
      total_tokens: 15,
    });

    // Bedrock client was called with a Converse-shape body (translation happened)
    expect(captured).toHaveLength(1);
    expect(captured[0].modelId).toBe("zai.glm-4.7");
    expect(captured[0].system).toEqual([{ text: "be brief" }]);
    expect(captured[0].messages).toEqual([
      { role: "user", content: [{ text: "hi" }] },
    ]);
  });

  test("assistant tool_calls + tool results translate correctly", async ({
    makeAgent,
  }) => {
    const captured: Record<string, unknown>[] = [];
    vi.spyOn(bedrockAdapterFactory, "createClient").mockImplementation(
      () =>
        ({
          converse: async (modelId: string, req: Record<string, unknown>) => {
            captured.push({ modelId, ...req });
            return {
              $metadata: { requestId: "req_2" },
              output: {
                message: {
                  role: "assistant",
                  content: [
                    {
                      toolUse: {
                        toolUseId: "t_new",
                        name: "get_weather",
                        input: { city: "NYC" },
                      },
                    },
                  ],
                },
              },
              stopReason: "tool_use",
              usage: { inputTokens: 20, outputTokens: 10 },
            };
          },
          converseStream: async () => asyncIterable([]),
        }) as never,
    );

    const app = createFastifyApp();
    await app.register(bedrockOpenaiProxyRoutes);
    const agent = await makeAgent({ name: "bedrock-openai-tools" });

    const response = await app.inject({
      method: "POST",
      url: `/v1/bedrock/openai/${agent.id}/chat/completions`,
      headers: HEADERS,
      payload: {
        model: "zai.glm-4.7",
        messages: [
          { role: "user", content: "weather?" },
          {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "t_old",
                type: "function",
                function: {
                  name: "get_weather",
                  arguments: '{"city":"SF"}',
                },
              },
            ],
          },
          { role: "tool", tool_call_id: "t_old", content: "sunny" },
        ],
        tools: [
          {
            type: "function",
            function: {
              name: "get_weather",
              description: "gets weather",
              parameters: {
                type: "object",
                properties: { city: { type: "string" } },
              },
            },
          },
        ],
        tool_choice: "auto",
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();

    // OpenAI-shape tool_calls in response
    expect(body.choices[0].finish_reason).toBe("tool_calls");
    expect(body.choices[0].message.tool_calls).toEqual([
      {
        id: "t_new",
        type: "function",
        function: {
          name: "get_weather",
          arguments: '{"city":"NYC"}',
        },
      },
    ]);

    // Converse body sent to Bedrock has correct toolConfig + messages
    const sent = captured[0] as Record<string, unknown> & {
      messages: Array<Record<string, unknown>>;
      toolConfig: Record<string, unknown>;
    };
    expect(sent.toolConfig).toMatchObject({
      tools: [
        {
          toolSpec: {
            name: "get_weather",
            description: "gets weather",
            inputSchema: { json: { type: "object" } },
          },
        },
      ],
      toolChoice: { auto: {} },
    });
    // The tool-result message (OpenAI role:"tool") became a user message with a toolResult block
    expect(sent.messages[2]).toEqual({
      role: "user",
      content: [
        {
          toolResult: {
            toolUseId: "t_old",
            content: [{ text: "sunny" }],
          },
        },
      ],
    });
    // The assistant tool_call arguments (JSON string) got parsed into an object
    expect(sent.messages[1]).toEqual({
      role: "assistant",
      content: [
        {
          toolUse: {
            toolUseId: "t_old",
            name: "get_weather",
            input: { city: "SF" },
          },
        },
      ],
    });
  });
});

describe("/v1/bedrock/openai/chat/completions — streaming", () => {
  afterEach(() => vi.restoreAllMocks());

  test("emits OpenAI SSE chunks and [DONE] terminator", async ({
    makeAgent,
  }) => {
    vi.spyOn(bedrockAdapterFactory, "createClient").mockImplementation(
      () =>
        ({
          converse: async () => ({}) as never,
          converseStream: async () =>
            asyncIterable([
              { messageStart: { role: "assistant" } },
              {
                contentBlockDelta: {
                  contentBlockIndex: 0,
                  delta: { text: "Hello" },
                },
              },
              {
                contentBlockDelta: {
                  contentBlockIndex: 0,
                  delta: { text: " world" },
                },
              },
              { messageStop: { stopReason: "end_turn" } },
              {
                metadata: {
                  usage: {
                    inputTokens: 5,
                    outputTokens: 2,
                    totalTokens: 7,
                  },
                },
              },
            ]),
        }) as never,
    );

    const app = createFastifyApp();
    await app.register(bedrockOpenaiProxyRoutes);
    const agent = await makeAgent({ name: "bedrock-openai-stream" });

    const response = await app.inject({
      method: "POST",
      url: `/v1/bedrock/openai/${agent.id}/chat/completions`,
      headers: HEADERS,
      payload: {
        model: "zai.glm-4.7",
        messages: [{ role: "user", content: "hi" }],
        stream: true,
      },
    });

    expect(response.statusCode).toBe(200);
    const events = parseSseChunks(response.body);

    // First chunk: role delta
    // biome-ignore lint/suspicious/noExplicitAny: inspection
    expect((events[0] as any).choices[0].delta).toEqual({ role: "assistant" });

    // content deltas (two of them)
    const contents = events
      // biome-ignore lint/suspicious/noExplicitAny: inspection
      .filter((e: any) => e?.choices?.[0]?.delta?.content)
      // biome-ignore lint/suspicious/noExplicitAny: inspection
      .map((e: any) => e.choices[0].delta.content);
    expect(contents).toEqual(["Hello", " world"]);

    // last real chunk carries finish_reason
    const finishIdx = events.findIndex(
      // biome-ignore lint/suspicious/noExplicitAny: inspection
      (e: any) => e?.choices?.[0]?.finish_reason != null,
    );
    expect(finishIdx).toBeGreaterThanOrEqual(0);
    // biome-ignore lint/suspicious/noExplicitAny: inspection
    expect((events[finishIdx] as any).choices[0].finish_reason).toBe("stop");

    // Terminator
    expect(events[events.length - 1]).toBe("[DONE]");
  });

  test("streaming tool call is re-emitted as OpenAI tool_calls deltas", async ({
    makeAgent,
  }) => {
    vi.spyOn(bedrockAdapterFactory, "createClient").mockImplementation(
      () =>
        ({
          converse: async () => ({}) as never,
          converseStream: async () =>
            asyncIterable([
              { messageStart: { role: "assistant" } },
              {
                contentBlockStart: {
                  contentBlockIndex: 0,
                  start: {
                    toolUse: { toolUseId: "t_1", name: "do_thing" },
                  },
                },
              },
              {
                contentBlockDelta: {
                  contentBlockIndex: 0,
                  delta: { toolUse: { input: '{"a":1}' } },
                },
              },
              { contentBlockStop: { contentBlockIndex: 0 } },
              { messageStop: { stopReason: "tool_use" } },
              {
                metadata: {
                  usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
                },
              },
            ]),
        }) as never,
    );

    const app = createFastifyApp();
    await app.register(bedrockOpenaiProxyRoutes);
    const agent = await makeAgent({ name: "bedrock-openai-stream-tool" });

    const response = await app.inject({
      method: "POST",
      url: `/v1/bedrock/openai/${agent.id}/chat/completions`,
      headers: HEADERS,
      payload: {
        model: "zai.glm-4.7",
        messages: [{ role: "user", content: "do the thing" }],
        tools: [
          {
            type: "function",
            function: {
              name: "do_thing",
              parameters: { type: "object", properties: {} },
            },
          },
        ],
        stream: true,
      },
    });

    expect(response.statusCode).toBe(200);
    const events = parseSseChunks(response.body);

    // tool-call opening: has id, name, empty args
    const open = events.find(
      // biome-ignore lint/suspicious/noExplicitAny: inspection
      (e: any) =>
        e?.choices?.[0]?.delta?.tool_calls?.[0]?.function?.name === "do_thing",
    );
    expect(open).toBeDefined();
    // biome-ignore lint/suspicious/noExplicitAny: inspection
    expect((open as any).choices[0].delta.tool_calls[0]).toMatchObject({
      index: 0,
      id: "t_1",
      type: "function",
      function: { name: "do_thing", arguments: "" },
    });

    // arg delta carries partial JSON
    const argsDelta = events.find(
      // biome-ignore lint/suspicious/noExplicitAny: inspection
      (e: any) =>
        e?.choices?.[0]?.delta?.tool_calls?.[0]?.function?.arguments?.length >
        0,
    );
    // biome-ignore lint/suspicious/noExplicitAny: inspection
    expect((argsDelta as any).choices[0].delta.tool_calls[0]).toMatchObject({
      index: 0,
      function: { arguments: '{"a":1}' },
    });

    // finish_reason tool_calls
    const finish = events.find(
      // biome-ignore lint/suspicious/noExplicitAny: inspection
      (e: any) => e?.choices?.[0]?.finish_reason != null,
    );
    // biome-ignore lint/suspicious/noExplicitAny: inspection
    expect((finish as any).choices[0].finish_reason).toBe("tool_calls");

    expect(events[events.length - 1]).toBe("[DONE]");
  });
});

describe("/v1/bedrock/openai/chat/completions — auth gate", () => {
  afterEach(() => vi.restoreAllMocks());

  test("returns 401 when no bearer is provided and IAM is disabled", async ({
    makeAgent,
  }) => {
    const createClientSpy = vi
      .spyOn(bedrockAdapterFactory, "createClient")
      .mockImplementation(() => ({}) as never);

    const app = createFastifyApp();
    await app.register(bedrockOpenaiProxyRoutes);
    const agent = await makeAgent({ name: "bedrock-openai-auth" });

    const response = await app.inject({
      method: "POST",
      url: `/v1/bedrock/openai/${agent.id}/chat/completions`,
      headers: {
        "content-type": "application/json",
        "user-agent": "test-client",
      },
      payload: {
        model: "zai.glm-4.7",
        messages: [{ role: "user", content: "hi" }],
      },
    });

    expect(response.statusCode).toBe(401);
    expect(response.body).toMatch(/Authentication required/i);
    // Crucially, we never reached the Bedrock adapter — no SigV4-time failure.
    expect(createClientSpy).not.toHaveBeenCalled();
  });
});
