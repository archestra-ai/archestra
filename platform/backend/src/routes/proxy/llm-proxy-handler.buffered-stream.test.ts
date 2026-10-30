import type { FastifyInstance } from "fastify";
import { vi } from "vitest";
import { createFastifyInstance } from "@/fastify-instance";
import { ModelModel } from "@/models";
import {
  type LlmProxyPlugin,
  registerLlmProxyPlugin,
} from "@/proxy/plugins/registry";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import { makePassthroughCredential } from "@/test/llm-proxy-credentials";
import type { Agent } from "@/types";
import {
  bedrockAdapterFactory,
  openAiResponsesAdapterFactory,
  openaiAdapterFactory,
} from "./adapters";
import { createOpenAiCodexClient } from "./adapters/openai-codex-client";
import { handleLLMProxy } from "./llm-proxy-handler";
import bedrockProxyRoutes from "./routes/bedrock";
import openAiProxyRoutes from "./routes/openai";

const MIB = 1024 * 1024;
const BUFFER_LIMIT_ERROR =
  "OpenAPPA child stream exceeded response buffer limit";
const BEDROCK_MODEL = "anthropic.claude-3-5-sonnet-20241022-v2:0";

describe("LLM proxy buffered model response streaming", () => {
  let app: FastifyInstance;
  let agent: Agent;
  let passthroughToken: string;
  let unregister: (() => void) | undefined;

  beforeEach(async ({ makeAgent, makeMember, makeUser }) => {
    app = createFastifyInstance();
    await app.register(openAiProxyRoutes);
    await app.register(bedrockProxyRoutes);
    app.post("/test/responses/:agentId", async (request, reply) =>
      handleLLMProxy(
        request.body as Parameters<
          typeof openAiResponsesAdapterFactory.createRequestAdapter
        >[0],
        request,
        reply,
        openAiResponsesAdapterFactory,
      ),
    );
    agent = await makeAgent({ agentType: "llm_proxy", isDefault: true });
    const owner = await makeUser();
    await makeMember(owner.id, agent.organizationId);
    passthroughToken = await makePassthroughCredential({
      organizationId: agent.organizationId,
      ownerId: owner.id,
    });
    for (const [provider, modelId] of [
      ["openai", "gpt-4o"],
      ["bedrock", BEDROCK_MODEL],
    ] as const) {
      await ModelModel.upsert({
        externalId: `${provider}/${modelId}`,
        provider,
        modelId,
        inputModalities: null,
        outputModalities: null,
        lastSyncedAt: new Date(),
      });
    }
  });

  afterEach(async () => {
    unregister?.();
    unregister = undefined;
    vi.restoreAllMocks();
    await app.close();
  });

  const bufferingPlugin = (hooks: Omit<LlmProxyPlugin, "id">): string => {
    const id = `test-buffered-stream-${crypto.randomUUID()}`;
    unregister = registerLlmProxyPlugin({
      id,
      buffersModelResponse: () => true,
      ...hooks,
    });
    return id;
  };

  const chatUpstream = (chunks: unknown[]) =>
    vi.spyOn(openaiAdapterFactory, "createClient").mockImplementation(
      () =>
        ({
          chat: { completions: { create: async () => iterate(chunks) } },
        }) as never,
    );

  const postChat = () =>
    app.inject({
      method: "POST",
      url: `/v1/openai/${agent.id}/chat/completions`,
      headers: {
        authorization: "Bearer test-key",
        "x-archestra-virtual-key": passthroughToken,
        "content-type": "application/json",
      },
      payload: {
        model: "gpt-4o",
        stream: true,
        messages: [{ role: "user", content: "check the weather" }],
        tools: [
          {
            type: "function",
            function: {
              name: "get_weather",
              parameters: { type: "object", properties: {} },
            },
          },
        ],
      },
    });

  describe("buffer limit", () => {
    test("counts discarded model output toward the limit a refusal is checked against", async () => {
      const refusal = "R".repeat(5 * MIB);
      bufferingPlugin({ onToolCalls: async () => refuse(refusal) });

      chatUpstream(chatTurn({ text: ["x".repeat(6 * MIB)], toolCall: true }));
      const overLimit = await postChat();
      // The content-free role preamble already committed the 200, so the
      // limit surfaces as an in-stream error frame.
      expect(overLimit.statusCode).toBe(200);
      expect(streamError(overLimit.body)).toBe(BUFFER_LIMIT_ERROR);
      expect(contentText(overLimit.body)).toBe("");

      chatUpstream(chatTurn({ text: ["small answer"], toolCall: true }));
      const underLimit = await postChat();
      expect(underLimit.statusCode).toBe(200);
      expect(streamError(underLimit.body)).toBeUndefined();
      expect(contentText(underLimit.body)).toBe(refusal);
    });

    test("does not count a plugin replacement toward the limit", async () => {
      const replacement = "P".repeat(5 * MIB);
      bufferingPlugin({
        onBufferedModelResponse: async () => ({
          decision: "replace",
          responseText: replacement,
        }),
      });
      chatUpstream(
        chatTurn({ text: ["x".repeat(4 * MIB), "y".repeat(4 * MIB)] }),
      );

      const response = await postChat();

      expect(response.statusCode).toBe(200);
      expect(streamError(response.body)).toBeUndefined();
      expect(contentText(response.body)).toBe(replacement);
    });

    test.for([
      { char: "a", overLimit: false },
      // Three UTF-8 bytes per character: under the limit in string length,
      // over it in bytes.
      { char: "€", overLimit: true },
    ])("sizes SSE strings by UTF-8 bytes ($char)", async ({
      char,
      overLimit,
    }) => {
      bufferingPlugin({});
      chatUpstream(
        chatTurn({ text: [0, 1, 2, 3].map(() => char.repeat(MIB)) }),
      );

      const response = await postChat();

      expect(response.statusCode).toBe(200);
      expect(streamError(response.body)).toBe(
        overLimit ? BUFFER_LIMIT_ERROR : undefined,
      );
      expect(contentText(response.body)).toHaveLength(overLimit ? 0 : 4 * MIB);
    });

    test.for([
      { char: "a", status: 200 },
      { char: "€", status: 413 },
    ])("sizes binary event-stream frames by byte length ($char)", async ({
      char,
      status,
    }) => {
      bufferingPlugin({});
      vi.spyOn(bedrockAdapterFactory, "createClient").mockReturnValue({
        converseStream: async () =>
          iterate(bedrockTurn([0, 1, 2, 3].map(() => char.repeat(MIB)))),
      } as never);

      const response = await app.inject({
        method: "POST",
        url: `/v1/bedrock/${agent.id}/converse-stream`,
        headers: {
          authorization: "Bearer test-key",
          "x-archestra-virtual-key": passthroughToken,
          "content-type": "application/json",
        },
        payload: {
          modelId: BEDROCK_MODEL,
          messages: [{ role: "user", content: [{ text: "hello" }] }],
        },
      });

      expect(response.statusCode).toBe(status);
    });
  });

  test("releases buffered model output before policy events", async () => {
    const decisions: string[] = [];
    bufferingPlugin({
      onBufferedModelResponse: async () => {
        decisions.push("buffered");
        return { decision: "release" };
      },
    });
    chatUpstream(chatTurn({ text: ["MODEL TEXT"], toolCall: true }));

    const response = await postChat();

    expect(response.statusCode).toBe(200);
    expect(decisions).toEqual(["buffered"]);
    const text = response.body.indexOf("MODEL TEXT");
    const toolCall = response.body.indexOf("get_weather");
    const done = response.body.indexOf("data: [DONE]");
    expect(text).toBeGreaterThanOrEqual(0);
    expect(toolCall).toBeGreaterThan(text);
    expect(done).toBeGreaterThan(toolCall);
  });

  describe("failure terminals withhold unadmitted buffered model output", () => {
    test.for([
      { cleanupThrows: false },
      { cleanupThrows: true },
    ])("Responses failed terminal (cleanupThrows=$cleanupThrows)", async ({
      cleanupThrows,
    }) => {
      const hooks: string[] = [];
      bufferingPlugin(terminalHooks(hooks, cleanupThrows));
      vi.spyOn(
        openAiResponsesAdapterFactory,
        "createClient",
      ).mockImplementation(
        () =>
          ({
            responses: {
              create: async () => iterate(responsesIncompleteTurn()),
            },
          }) as never,
      );

      const response = await app.inject({
        method: "POST",
        url: `/test/responses/${agent.id}`,
        headers: {
          authorization: "Bearer test-key",
          "x-archestra-virtual-key": passthroughToken,
          "content-type": "application/json",
        },
        payload: { model: "gpt-4o", input: "hello", stream: true },
      });

      expect(response.statusCode).toBe(200);
      expect(hooks).toEqual(["error", "cleanup"]);
      expect(response.body).not.toContain("PARTIAL RESPONSES TEXT");
      expect(response.body).not.toContain("PARTIAL RESPONSES REASONING");
      const terminal = sseFrames(response.body).find(
        (frame) => frame.type === "response.incomplete",
      );
      expect(terminal?.response).toMatchObject({
        status: "incomplete",
        incomplete_details: { reason: "max_output_tokens" },
        usage: { total_tokens: 3 },
      });
      expect(response.body.indexOf("data: [DONE]")).toBeGreaterThan(
        response.body.indexOf('"status":"incomplete"'),
      );
      expect(response.body).not.toContain("call_held");
    });

    test.for([
      { cleanupThrows: false },
      { cleanupThrows: true },
    ])("Codex incomplete terminal (cleanupThrows=$cleanupThrows)", async ({
      cleanupThrows,
    }) => {
      const hooks: string[] = [];
      bufferingPlugin(terminalHooks(hooks, cleanupThrows));
      vi.spyOn(openaiAdapterFactory, "createClient").mockImplementation(
        (_key, options) =>
          createOpenAiCodexClient({
            options,
            innerFetch: async () =>
              new Response(codexIncompleteSse(), {
                headers: { "content-type": "text/event-stream" },
              }),
            credential: {
              refreshToken: "test-refresh-token",
              accountId: "test-account",
              accessToken: "test-access-token",
              accessTokenExpiresAtMs: Date.now() + 60 * 60 * 1000,
            },
          }),
      );

      const response = await postChat();

      expect(response.statusCode).toBe(200);
      expect(hooks).toEqual(["error", "cleanup"]);
      expect(response.body).not.toContain("PARTIAL CODEX TEXT");
      const terminal = response.body.indexOf('"finish_reason":"length"');
      const done = response.body.indexOf("data: [DONE]");
      expect(terminal).toBeGreaterThanOrEqual(0);
      expect(done).toBeGreaterThan(terminal);
      expect(
        sseFrames(response.body).some(
          (frame) => frame.usage?.total_tokens === 3,
        ),
      ).toBe(true);
      expect(response.body).not.toContain("call_held");
    });
  });

  test.for([
    { failingHook: "onBufferedModelResponse" as const },
    { failingHook: "onModelResponse" as const },
  ])("releases nothing buffered when $failingHook fails", async ({
    failingHook,
  }) => {
    const pluginId = bufferingPlugin({
      [failingHook]: async () => {
        throw new Error("hook failed");
      },
    });
    chatUpstream(chatTurn({ text: ["UNREVIEWED TEXT"], toolCall: true }));

    const response = await postChat();

    expect(response.statusCode).toBe(200);
    expect(streamError(response.body)).toBe(
      `LLM proxy plugin ${pluginId} failed during ${failingHook}`,
    );
    expect(contentText(response.body)).toBe("");
    expect(response.body).not.toContain("get_weather");
  });
});

function iterate<T>(items: readonly T[]): AsyncIterable<T> {
  return {
    async *[Symbol.asyncIterator]() {
      yield* items;
    },
  };
}

function refuse(contentMessage: string) {
  return {
    decision: "refuse" as const,
    refusal: {
      refusalMessage: contentMessage,
      contentMessage,
      reason: "test refusal",
      blockedToolName: "get_weather",
      toolInput: {},
      allToolCallNames: ["get_weather"],
    },
  };
}

function terminalHooks(
  hooks: string[],
  cleanupThrows: boolean,
): Omit<LlmProxyPlugin, "id"> {
  return {
    onBufferedModelResponse: async () => {
      hooks.push("buffered");
      return { decision: "release" };
    },
    onComplete: async () => {
      hooks.push("complete");
    },
    onError: async () => {
      hooks.push("error");
      if (cleanupThrows) throw new Error("plugin failure cleanup failed");
    },
    onCleanup: async () => {
      hooks.push("cleanup");
    },
  };
}

function chatTurn(params: { text: string[]; toolCall?: boolean }) {
  const chunk = (delta: object, finish_reason: string | null = null) => ({
    id: "chatcmpl-buffered",
    object: "chat.completion.chunk",
    created: 1,
    model: "gpt-4o",
    choices: [{ index: 0, delta, finish_reason, logprobs: null }],
  });
  return [
    chunk({ role: "assistant", content: "" }),
    ...params.text.map((content) => chunk({ content })),
    ...(params.toolCall
      ? [
          chunk({
            tool_calls: [
              {
                index: 0,
                id: "call_weather",
                type: "function",
                function: { name: "get_weather", arguments: "{}" },
              },
            ],
          }),
        ]
      : []),
    chunk({}, params.toolCall ? "tool_calls" : "stop"),
    {
      ...chunk({}),
      choices: [],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    },
  ];
}

function bedrockTurn(text: string[]) {
  return [
    { messageStart: { role: "assistant" } },
    ...text.map((chunk) => ({
      contentBlockDelta: { contentBlockIndex: 0, delta: { text: chunk } },
    })),
    { contentBlockStop: { contentBlockIndex: 0 } },
    { messageStop: { stopReason: "end_turn" } },
    { metadata: { usage: { inputTokens: 1, outputTokens: 1 } } },
  ];
}

function responsesIncompleteTurn() {
  const envelope = {
    id: "resp-buffered",
    object: "response",
    created_at: 1,
    model: "gpt-4o",
  };
  const message = {
    id: "msg-buffered",
    type: "message",
    role: "assistant",
    status: "in_progress",
    content: [],
  };
  return [
    {
      type: "response.created",
      sequence_number: 0,
      response: { ...envelope, status: "in_progress", output: [] },
    },
    {
      type: "response.output_item.added",
      output_index: 0,
      sequence_number: 1,
      item: message,
    },
    {
      type: "response.content_part.added",
      item_id: message.id,
      output_index: 0,
      content_index: 0,
      sequence_number: 2,
      part: { type: "output_text", text: "", annotations: [] },
    },
    {
      type: "response.output_text.delta",
      item_id: message.id,
      output_index: 0,
      content_index: 0,
      sequence_number: 3,
      delta: "PARTIAL RESPONSES TEXT",
    },
    {
      type: "response.output_item.added",
      output_index: 1,
      sequence_number: 4,
      item: {
        id: "fc_held",
        type: "function_call",
        call_id: "call_held",
        name: "get_weather",
        arguments: "",
        status: "in_progress",
      },
    },
    {
      type: "response.output_item.done",
      output_index: 2,
      sequence_number: 5,
      item: {
        id: "rs-buffered",
        type: "reasoning",
        summary: [
          { type: "summary_text", text: "PARTIAL RESPONSES REASONING" },
        ],
      },
    },
    {
      type: "response.incomplete",
      sequence_number: 6,
      response: {
        ...envelope,
        status: "incomplete",
        incomplete_details: { reason: "max_output_tokens" },
        output: [],
        usage: {
          input_tokens: 2,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens: 1,
          output_tokens_details: { reasoning_tokens: 0 },
          total_tokens: 3,
        },
      },
    },
  ];
}

function codexIncompleteSse(): string {
  const usage = {
    input_tokens: 2,
    input_tokens_details: { cached_tokens: 0 },
    output_tokens: 1,
    total_tokens: 3,
  };
  return [
    {
      type: "response.created",
      response: { id: "resp-codex", status: "in_progress", output: [], usage },
    },
    { type: "response.output_text.delta", delta: "PARTIAL CODEX TEXT" },
    {
      type: "response.output_item.added",
      item: {
        id: "fc_held",
        type: "function_call",
        call_id: "call_held",
        name: "get_weather",
        arguments: '{"location":',
      },
    },
    {
      type: "response.incomplete",
      response: {
        id: "resp-codex",
        status: "incomplete",
        output: [],
        incomplete_details: { reason: "max_output_tokens" },
        error: null,
        usage,
      },
    },
  ]
    .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
    .join("");
}

function contentText(body: string): string {
  return sseFrames(body)
    .map((frame) => frame.choices?.[0]?.delta?.content ?? "")
    .join("");
}

function streamError(body: string): string | undefined {
  return sseFrames(body).find((frame) => frame.type === "error")?.error
    ?.message;
}

function sseFrames(body: string): SseFrame[] {
  return body
    .split("\n")
    .filter((line) => line.startsWith("data: ") && line !== "data: [DONE]")
    .map((line) => JSON.parse(line.slice("data: ".length)) as SseFrame);
}

type SseFrame = {
  type?: string;
  response?: Record<string, unknown>;
  usage?: { total_tokens?: number };
  error?: { message?: string };
  choices?: { delta?: { content?: string } }[];
};
