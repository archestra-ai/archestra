import { afterEach, describe, expect, test, vi } from "vitest";
import {
  canReachMember,
  inboundPoolWire,
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
  });

  test("is undefined when the request sets no usable limit", () => {
    expect(requestedMaxOutputTokens({ messages: [] })).toBeUndefined();
    expect(requestedMaxOutputTokens({ max_tokens: 0 })).toBeUndefined();
    expect(requestedMaxOutputTokens({ max_tokens: "100" })).toBeUndefined();
    expect(requestedMaxOutputTokens(null)).toBeUndefined();
  });
});

describe("which members a client's wire reaches", () => {
  test("names the wire a request arrived in", () => {
    expect(inboundPoolWire("openai:chatCompletions")).toBe("openai-chat");
    expect(inboundPoolWire("zhipuai:chatCompletions")).toBe("openai-chat");
    expect(inboundPoolWire("anthropic:messages")).toBe("anthropic");
    expect(inboundPoolWire("bedrock:converse")).toBe("bedrock-converse");
    expect(inboundPoolWire("gemini:generateContent")).toBeNull();
  });

  test("reaches the same wire and the pairs a translator connects", () => {
    expect(canReachMember("openai-chat", "zhipuai")).toBe(true);
    expect(canReachMember("openai-chat", "anthropic")).toBe(true);
    expect(canReachMember("openai-chat", "bedrock")).toBe(true);
    expect(canReachMember("anthropic", "zhipuai")).toBe(true);
    expect(canReachMember("anthropic", "bedrock")).toBe(false);
    expect(canReachMember("bedrock-converse", "zhipuai")).toBe(false);
    expect(canReachMember("openai-chat", "gemini")).toBe(false);
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
    const events = await collect(
      await transport.executeStream({
        model: "glm-5",
        max_tokens: 100,
        stream: true,
        messages: [{ role: "user", content: "hello" }],
      }),
    );

    expect(executeStream).toHaveBeenCalledWith(
      "client",
      expect.objectContaining({
        model: "glm-5",
        stream: true,
        messages: [{ role: "user", content: "hello" }],
      }),
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

  test("refuses a member the wire cannot reach", () => {
    expect(() =>
      memberTransport({
        inbound: "bedrock-converse",
        provider: "zhipuai",
        modelId: "glm-5",
        client: "client",
      }),
    ).toThrow(/cannot reach/);
  });
});
