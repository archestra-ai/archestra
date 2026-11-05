import { EventStreamCodec } from "@smithy/eventstream-codec";
import { fromUtf8, toUtf8 } from "@smithy/util-utf8";
import { HttpResponse, http } from "msw";
import { afterEach, describe, expect, test, vi } from "vitest";
import { BedrockClient } from "@/clients/bedrock-client";
import { useMswServer } from "@/test/msw";
import {
  canReachMember,
  memberAdapter,
  memberTransport,
  requestedMaxOutputTokens,
} from "./model-pool-transport";

async function collect(stream: AsyncIterable<unknown>) {
  const items: unknown[] = [];
  for await (const item of stream) items.push(item);
  return items;
}

async function* from(items: unknown[]) {
  yield* items;
}

describe("the output a request allows", () => {
  test("reads the limit from each pool wire", () => {
    expect(requestedMaxOutputTokens({ max_tokens: 4096 })).toBe(4096);
    expect(
      requestedMaxOutputTokens({ max_completion_tokens: 900, max_tokens: 10 }),
    ).toBe(900);
    expect(
      requestedMaxOutputTokens({ inferenceConfig: { maxTokens: 512 } }),
    ).toBe(512);
    expect(
      requestedMaxOutputTokens({ generationConfig: { maxOutputTokens: 2048 } }),
    ).toBe(2048);
  });

  test("is undefined when the request sets no limit", () => {
    expect(requestedMaxOutputTokens({ messages: [] })).toBeUndefined();
  });
});

describe("which members a client's wire reaches", () => {
  test("reaches the same wire and the pairs a translator connects", () => {
    expect(canReachMember("openai-chat", "zhipuai")).toBe(true);
    expect(canReachMember("openai-chat", "anthropic")).toBe(true);
    expect(canReachMember("openai-chat", "bedrock")).toBe(true);
    expect(canReachMember("anthropic", "zhipuai")).toBe(true);
    expect(canReachMember("anthropic", "bedrock")).toBe(true);
    expect(canReachMember("bedrock-converse", "zhipuai")).toBe(false);
    expect(canReachMember("openai-chat", "gemini")).toBe(true);
    expect(canReachMember("anthropic", "gemini")).toBe(true);
    expect(canReachMember("bedrock-converse", "gemini")).toBe(false);
    expect(canReachMember("gemini", "gemini")).toBe(true);
    expect(canReachMember("gemini", "openai")).toBe(true);
    expect(canReachMember("gemini", "anthropic")).toBe(true);
  });
});

describe("memberTransport", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("sends the same wire as is, with the member's model id", async () => {
    // biome-ignore lint/style/noNonNullAssertion: zhipuai is poolable
    const adapter = memberAdapter("zhipuai")!;
    const execute = vi
      .spyOn(adapter, "execute")
      .mockResolvedValue({ answered: true });

    const transport = memberTransport({
      inbound: "openai-chat",
      provider: "zhipuai",
      modelId: "glm-5-turbo",
      client: "client",
    });
    await expect(
      transport.execute({ model: "glm-5", messages: [] }),
    ).resolves.toEqual({ answered: true });
    expect(execute).toHaveBeenCalledWith("client", {
      model: "glm-5-turbo",
      messages: [],
    });
  });

  test("answers a Claude Code request from an OpenAI-style member", async () => {
    // biome-ignore lint/style/noNonNullAssertion: zhipuai is poolable
    const adapter = memberAdapter("zhipuai")!;
    const executeStream = vi.spyOn(adapter, "executeStream").mockResolvedValue(
      from([
        {
          choices: [
            { index: 0, delta: { content: "Hi" }, finish_reason: null },
          ],
        },
        { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
      ]) as never,
    );

    const transport = memberTransport({
      inbound: "anthropic",
      provider: "zhipuai",
      modelId: "glm-5",
      client: "client",
    });
    const onAccepted = () => {};
    const events = await collect(
      await transport.executeStream(
        {
          model: "glm-5",
          max_tokens: 100,
          stream: true,
          messages: [{ role: "user", content: "hello" }],
        },
        onAccepted,
      ),
    );

    expect(executeStream).toHaveBeenCalledWith(
      "client",
      expect.objectContaining({
        model: "glm-5",
        stream: true,
        messages: [{ role: "user", content: "hello" }],
      }),
      onAccepted,
    );
    expect(events).toEqual([
      expect.objectContaining({ type: "message_start" }),
      expect.objectContaining({ type: "content_block_start", index: 0 }),
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "Hi" },
      },
      { type: "content_block_stop", index: 0 },
      expect.objectContaining({
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
      }),
      { type: "message_stop" },
    ]);
  });

  test("sends a Claude Code request to Claude on Bedrock as is", async () => {
    const reply = {
      id: "msg_1",
      type: "message",
      role: "assistant",
      model: "us.anthropic.claude-haiku-4-5",
      content: [{ type: "text", text: "Hi" }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 3, output_tokens: 1 },
    };
    const events = [{ type: "message_start" }, { type: "message_stop" }];
    const client = {
      invoke: vi.fn().mockResolvedValue(reply),
      invokeStream: vi.fn().mockResolvedValue(from(events)),
    };
    const transport = memberTransport({
      inbound: "anthropic",
      provider: "bedrock",
      modelId: "us.anthropic.claude-haiku-4-5",
      client,
    });
    const request = {
      model: "claude-haiku",
      max_tokens: 100,
      stream: true,
      messages: [{ role: "user", content: "hello" }],
    };

    await expect(transport.execute(request)).resolves.toEqual(reply);
    expect(await collect(await transport.executeStream(request))).toEqual(
      events,
    );
    // The model goes in the URL; the body carries Bedrock's protocol version.
    const body = {
      anthropic_version: "bedrock-2023-05-31",
      max_tokens: 100,
      messages: [{ role: "user", content: "hello" }],
    };
    expect(client.invoke).toHaveBeenCalledWith(
      "us.anthropic.claude-haiku-4-5",
      body,
    );
    expect(client.invokeStream).toHaveBeenCalledWith(
      "us.anthropic.claude-haiku-4-5",
      body,
    );
  });

  test("streams another Bedrock model back to a Claude Code request", async () => {
    // biome-ignore lint/style/noNonNullAssertion: bedrock is poolable
    const adapter = memberAdapter("bedrock")!;
    const executeStream = vi.spyOn(adapter, "executeStream").mockResolvedValue(
      from([
        { messageStart: { role: "assistant" } },
        { contentBlockDelta: { contentBlockIndex: 0, delta: { text: "Hi" } } },
        { contentBlockStop: { contentBlockIndex: 0 } },
        { messageStop: { stopReason: "end_turn" } },
        {
          metadata: {
            usage: { inputTokens: 3, outputTokens: 1, totalTokens: 4 },
          },
        },
      ]) as never,
    );
    const transport = memberTransport({
      inbound: "anthropic",
      provider: "bedrock",
      modelId: "us.zai.glm-5",
      client: "client",
    });

    const onAccepted = () => {};
    const events = await collect(
      await transport.executeStream(
        {
          model: "glm-5",
          max_tokens: 100,
          stream: true,
          messages: [{ role: "user", content: "hello" }],
        },
        onAccepted,
      ),
    );

    expect(executeStream).toHaveBeenCalledWith(
      "client",
      expect.objectContaining({
        modelId: "us.zai.glm-5",
        messages: [{ role: "user", content: [{ text: "hello" }] }],
      }),
      onAccepted,
    );
    expect(events).toContainEqual({
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "Hi" },
    });
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
      }),
    );
    expect(events.at(-1)).toEqual({ type: "message_stop" });
  });

  test("answers an OpenAI request from an Anthropic member, usage last", async () => {
    // biome-ignore lint/style/noNonNullAssertion: anthropic is poolable
    const adapter = memberAdapter("anthropic")!;
    vi.spyOn(adapter, "executeStream").mockResolvedValue(
      from([
        {
          type: "message_start",
          message: { usage: { input_tokens: 7, output_tokens: 0 } },
        },
        {
          type: "content_block_start",
          index: 0,
          content_block: { type: "text", text: "" },
        },
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "Hi" },
        },
        {
          type: "message_delta",
          delta: { stop_reason: "end_turn" },
          usage: { output_tokens: 3 },
        },
        { type: "message_stop" },
      ]) as never,
    );

    const transport = memberTransport({
      inbound: "openai-chat",
      provider: "anthropic",
      modelId: "claude-haiku-4-5",
      client: "client",
    });
    const chunks = (await collect(
      await transport.executeStream({
        model: "haiku",
        stream: true,
        messages: [{ role: "user", content: "hello" }],
      }),
    )) as Array<{
      choices: Array<{ delta: unknown; finish_reason: unknown }>;
      usage?: unknown;
    }>;

    expect(chunks.map((chunk) => chunk.choices[0]?.delta)).toEqual([
      { role: "assistant" },
      { content: "Hi" },
      {},
      undefined,
    ]);
    expect(chunks[2].choices[0].finish_reason).toBe("stop");
    expect(chunks[3].usage).toEqual({
      prompt_tokens: 7,
      completion_tokens: 3,
      total_tokens: 10,
    });
  });

  test("errors on an Anthropic stream that was cut off", async () => {
    // biome-ignore lint/style/noNonNullAssertion: anthropic is poolable
    const adapter = memberAdapter("anthropic")!;
    vi.spyOn(adapter, "executeStream").mockResolvedValue(
      from([
        { type: "message_start", message: { usage: { input_tokens: 7 } } },
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "Hal" },
        },
      ]) as never,
    );
    const transport = memberTransport({
      inbound: "openai-chat",
      provider: "anthropic",
      modelId: "claude-haiku-4-5",
      client: "client",
    });
    await expect(
      collect(await transport.executeStream({ model: "haiku", messages: [] })),
    ).rejects.toThrow(/ended before it finished/);
  });
});

// biome-ignore lint/correctness/useHookAtTopLevel: Vitest lifecycle helper
const bedrockServer = useMswServer();
for (const inbound of ["openai-chat", "anthropic", "gemini"] as const) {
  for (const stream of [false, true]) {
    test(`normalizes Gemini tool history for a Bedrock fallback (${inbound}, stream=${stream})`, async () => {
      const signedId = `gemsig-${"s".repeat(100)}.call-1`;
      const bodies: {
        messages: { content: Record<string, { toolUseId: string }>[] }[];
      }[] = [];
      bedrockServer.use(
        http.post(
          "https://bedrock.pool.test/model/:model/:operation",
          async ({ request }) => {
            bodies.push((await request.json()) as (typeof bodies)[number]);
            return stream
              ? new HttpResponse(
                  new EventStreamCodec(toUtf8, fromUtf8).encode({
                    headers: {
                      ":message-type": { type: "string", value: "event" },
                      ":event-type": { type: "string", value: "messageStop" },
                      ":content-type": {
                        type: "string",
                        value: "application/json",
                      },
                    },
                    body: fromUtf8(JSON.stringify({ stopReason: "end_turn" })),
                  }),
                  {
                    headers: {
                      "content-type": "application/vnd.amazon.eventstream",
                    },
                  },
                )
              : HttpResponse.json({
                  output: {
                    message: { role: "assistant", content: [{ text: "done" }] },
                  },
                  stopReason: "end_turn",
                  usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
                });
          },
        ),
      );
      const transport = memberTransport({
        inbound,
        provider: "bedrock",
        modelId: "amazon.nova-lite-v1:0",
        client: new BedrockClient({
          baseUrl: "https://bedrock.pool.test",
          region: "us-east-1",
          apiKey: "synthetic-bedrock-key",
        }),
      });
      const request =
        inbound === "gemini"
          ? {
              contents: [
                {
                  role: "model",
                  parts: [
                    {
                      functionCall: {
                        id: signedId,
                        name: "read_value",
                        args: {},
                      },
                      thoughtSignature: "synthetic",
                    },
                  ],
                },
                {
                  role: "user",
                  parts: [
                    {
                      functionResponse: {
                        id: signedId,
                        name: "read_value",
                        response: { content: "done" },
                      },
                    },
                  ],
                },
              ],
              generationConfig: { maxOutputTokens: 16 },
            }
          : {
              model: "pool",
              max_tokens: 16,
              messages:
                inbound === "openai-chat"
                  ? [
                      {
                        role: "assistant",
                        content: null,
                        tool_calls: [
                          {
                            id: signedId,
                            type: "function",
                            function: { name: "read_value", arguments: "{}" },
                          },
                        ],
                      },
                      { role: "tool", tool_call_id: signedId, content: "done" },
                    ]
                  : [
                      {
                        role: "assistant",
                        content: [
                          {
                            type: "tool_use",
                            id: signedId,
                            name: "read_value",
                            input: {},
                          },
                        ],
                      },
                      {
                        role: "user",
                        content: [
                          {
                            type: "tool_result",
                            tool_use_id: signedId,
                            content: "done",
                          },
                        ],
                      },
                    ],
            };
      if (stream) await collect(await transport.executeStream(request));
      else await transport.execute(request);
      expect(bodies).toHaveLength(1);
      const use = bodies[0].messages[0].content[0].toolUse.toolUseId;
      const result = bodies[0].messages[1].content[0].toolResult.toolUseId;
      expect(use).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
      expect(result).toBe(use);
      expect(use).not.toBe(signedId);
    });
  }
}
