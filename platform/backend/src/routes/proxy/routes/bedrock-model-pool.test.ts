import { EventStreamCodec } from "@smithy/eventstream-codec";
import { fromUtf8, toUtf8 } from "@smithy/util-utf8";
import type { LightMyRequestResponse } from "fastify";
import { HttpResponse, http } from "msw";
import { vi } from "vitest";
import config from "@/config";
import { createFastifyInstance } from "@/fastify-instance";
import { ModelPoolModel, VirtualApiKeyModel } from "@/models";
import { accessGrants, expect, test } from "@/test";
import { setupTestCacheManager } from "@/test/cache-manager";
import { useMswServer } from "@/test/msw";
import bedrockProxyRoutes from "./bedrock";

// Actual Converse routes and pool logic; only synthetic upstream HTTP is stubbed.
// biome-ignore lint/correctness/useHookAtTopLevel: Vitest lifecycle helper.
const server = useMswServer();
setupTestCacheManager();
const bedrockOrigin = "https://bedrock-fallback.example.test";
const openaiOrigin = "https://openai-fallback.example.test/v1";
const anthropicOrigin = "https://anthropic-fallback.example.test";
const awsModel = "anthropic.claude-sonnet-4-6";
const poolName = "converse-fallback";
const fallbackFirstName = "converse-fallback-first";
const bedrockOnlyName = "converse-bedrock-only";
const toolSpec = {
  name: "look_up",
  inputSchema: {
    json: { type: "object", properties: { term: { type: "string" } } },
  },
};

const poolTest = test.extend<{
  converse: {
    ask: (
      body: Record<string, unknown>,
      stream?: boolean,
      pool?: string,
    ) => Promise<LightMyRequestResponse>;
    aws: ReturnType<typeof vi.fn>;
    openai: ReturnType<typeof vi.fn>;
    anthropic: ReturnType<typeof vi.fn>;
  };
}>({
  converse: async (
    { makeOrganization, makeAgent, makeSecret, makeLlmProviderApiKey },
    use,
  ) => {
    const original = { ...config.llm.bedrock };
    config.llm.bedrock.baseUrl = bedrockOrigin;
    config.llm.bedrock.iamAuthEnabled = false;
    const org = await makeOrganization();
    const agent = await makeAgent({ organizationId: org.id });
    const createKey = async (
      provider: "bedrock" | "openai" | "anthropic",
      baseUrl: string,
    ) =>
      makeLlmProviderApiKey(
        org.id,
        (await makeSecret({ secret: { apiKey: "synthetic-key" } })).id,
        { provider, baseUrl },
      );
    const bedrock = await createKey("bedrock", bedrockOrigin);
    const openaiKey = await createKey("openai", openaiOrigin);
    const anthropicKey = await createKey("anthropic", anthropicOrigin);
    const { value, virtualKey } = await VirtualApiKeyModel.create({
      organizationId: org.id,
      name: "Converse client",
      ...accessGrants("org"),
      providerApiKeys: [{ provider: "bedrock", providerApiKeyId: bedrock.id }],
    });
    const createPool = (name: string, members: string[][]) =>
      ModelPoolModel.create({
        organizationId: org.id,
        input: {
          name,
          members: members.map(([providerApiKeyId, modelId], index) => ({
            providerApiKeyId,
            modelId,
            priority: index + 1,
            weight: 1,
            enabled: true,
          })),
        },
      });
    const awsMember = [bedrock.id, awsModel];
    const openaiMember = [openaiKey.id, "gpt-4.1-mini"];
    const anthropicMember = [anthropicKey.id, "claude-sonnet-4-6"];
    const pool = await createPool(poolName, [
      awsMember,
      openaiMember,
      anthropicMember,
    ]);
    const fallbackFirst = await createPool(fallbackFirstName, [
      openaiMember,
      awsMember,
      anthropicMember,
    ]);
    const bedrockOnly = await createPool(bedrockOnlyName, [awsMember]);
    await ModelPoolModel.setPoolsForVirtualApiKey({
      organizationId: org.id,
      virtualApiKeyId: virtualKey.id,
      poolIds: [pool.id, fallbackFirst.id, bedrockOnly.id],
    });

    const transient = () =>
      HttpResponse.json(
        { message: "Synthetic capacity error" },
        { status: 503 },
      );
    const aws = vi.fn((_request: unknown) => transient());
    const openai = vi.fn((_request: unknown) => transient());
    const anthropic = vi.fn((_request: unknown) => transient());
    server.use(
      http.post(
        `${bedrockOrigin}/model/:modelId/:operation`,
        async ({ request }) => aws(await request.json()),
      ),
      http.post(`${openaiOrigin}/chat/completions`, async ({ request }) =>
        openai(await request.json()),
      ),
      http.post(`${anthropicOrigin}/v1/messages`, async ({ request }) =>
        anthropic(await request.json()),
      ),
    );
    const app = createFastifyInstance();
    await app.register(bedrockProxyRoutes);
    try {
      await use({
        ask: (payload, stream, pool = poolName) =>
          app.inject({
            method: "POST",
            url: `/v1/bedrock/${agent.id}/model/${pool}/${stream ? "converse-stream" : "converse"}`,
            headers: { authorization: `Bearer ${value}` },
            payload,
          }),
        aws,
        openai,
        anthropic,
      });
    } finally {
      Object.assign(config.llm.bedrock, original);
      await app.close();
    }
  },
});

function decodeFrames(payload: Buffer) {
  const codec = new EventStreamCodec(toUtf8, fromUtf8);
  const frames = [];
  for (let start = 0; start < payload.length; ) {
    const size = payload.readUInt32BE(start);
    const event = codec.decode(payload.subarray(start, start + size));
    // Ignore transport padding; decode and assert the AWS event fields.
    const { p: _padding, ...body } = JSON.parse(toUtf8(event.body));
    frames.push([event.headers[":event-type"]?.value, body]);
    start += size;
  }
  return frames;
}

function anthropicSse<T extends { type: string }>(events: T[]) {
  return new HttpResponse(
    events
      .map(
        (event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
      )
      .join(""),
    { headers: { "content-type": "text/event-stream" } },
  );
}

const request = {
  system: [{ text: "Be concise." }],
  messages: [{ role: "user", content: [{ text: "Find this." }] }],
  inferenceConfig: { maxTokens: 32 },
  toolConfig: {
    tools: [{ toolSpec }],
    toolChoice: { tool: { name: toolSpec.name } },
  },
};

poolTest(
  "falls back from native Converse to OpenAI and returns a Converse tool turn",
  async ({ converse }) => {
    const { ask, aws, openai, anthropic } = converse;
    openai.mockImplementation(() =>
      HttpResponse.json({
        id: "chatcmpl-synthetic",
        object: "chat.completion",
        created: 1,
        model: "gpt-4.1-mini",
        choices: [
          {
            index: 0,
            finish_reason: "tool_calls",
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "call_synthetic",
                  type: "function",
                  function: { name: "look_up", arguments: '{"term":"item"}' },
                },
              ],
            },
          },
        ],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 2,
          total_tokens: 12,
          prompt_tokens_details: { cached_tokens: 4 },
        },
      }),
    );
    const response = await ask(request);
    expect(response.statusCode, response.body).toBe(200);
    expect(aws).toHaveBeenCalledOnce();
    expect(openai).toHaveBeenCalledOnce();
    expect(anthropic).not.toHaveBeenCalled();
    expect(openai).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "gpt-4.1-mini",
        max_completion_tokens: 32,
        messages: [
          { role: "system", content: "Be concise." },
          { role: "user", content: [{ type: "text", text: "Find this." }] },
        ],
        tool_choice: { type: "function", function: { name: "look_up" } },
      }),
    );
    expect(response.json()).toMatchObject({
      output: {
        message: {
          role: "assistant",
          content: [
            {
              toolUse: {
                toolUseId: "call_synthetic",
                name: "look_up",
                input: { term: "item" },
              },
            },
          ],
        },
      },
      stopReason: "tool_use",
      usage: {
        inputTokens: 6,
        outputTokens: 2,
        totalTokens: 12,
        cacheReadInputTokens: 4,
      },
    });
    const assistant = response.json().output.message;
    const callId = assistant.content[0].toolUse.toolUseId;
    // Send the tool result back with the original client-visible ID.
    const replay = await ask({
      ...request,
      messages: [
        ...request.messages,
        assistant,
        {
          role: "user",
          content: [
            { toolResult: { toolUseId: callId, content: [{ text: "found" }] } },
          ],
        },
      ],
    });
    expect(replay.statusCode, replay.body).toBe(200);
    expect(openai).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        messages: expect.arrayContaining([
          expect.objectContaining({
            role: "assistant",
            tool_calls: [expect.objectContaining({ id: callId })],
          }),
          { role: "tool", tool_call_id: callId, content: "found" },
        ]),
      }),
    );
  },
);

poolTest(
  "returns AWS eventstream through the existing direct Anthropic translator",
  async ({ converse }) => {
    const { ask, aws, openai, anthropic } = converse;
    const events = [
      {
        type: "message_start",
        message: {
          id: "msg_synthetic",
          type: "message",
          role: "assistant",
          content: [],
          model: "claude-sonnet-4-6",
          stop_reason: null,
          usage: { input_tokens: 9, output_tokens: 0 },
        },
      },
      {
        type: "content_block_start",
        index: 0,
        content_block: {
          type: "tool_use",
          id: "toolu_synthetic",
          name: "look_up",
          input: {},
        },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: '{"term":' },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: '"item"}' },
      },
      { type: "content_block_stop", index: 0 },
      {
        type: "message_delta",
        delta: { stop_reason: "tool_use", stop_sequence: null },
        usage: { output_tokens: 2 },
      },
      { type: "message_stop" },
    ];
    anthropic.mockImplementation(() => anthropicSse(events));
    const response = await ask(request, true);
    expect(response.statusCode, response.body).toBe(200);
    expect(aws).toHaveBeenCalledOnce();
    expect(openai).toHaveBeenCalledOnce();
    expect(anthropic).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "claude-sonnet-4-6",
        max_tokens: 32,
        system: "Be concise.",
        stream: true,
        tool_choice: { type: "tool", name: "look_up" },
      }),
    );
    expect(response.headers["content-type"]).toContain(
      "application/vnd.amazon.eventstream",
    );
    const frames = decodeFrames(response.rawPayload);
    expect(frames).toEqual([
      ["messageStart", { role: "assistant" }],
      [
        "contentBlockStart",
        {
          contentBlockIndex: 0,
          start: { toolUse: { toolUseId: "toolu_synthetic", name: "look_up" } },
        },
      ],
      [
        "contentBlockDelta",
        {
          contentBlockIndex: 0,
          delta: { toolUse: { input: '{"term":"item"}' } },
        },
      ],
      ["contentBlockStop", { contentBlockIndex: 0 }],
      ["messageStop", { stopReason: "tool_use" }],
      [
        "metadata",
        { usage: { inputTokens: 9, outputTokens: 2, totalTokens: 11 } },
      ],
    ]);
  },
);

poolTest(
  "never dispatches AWS-specific guardrails or unknown raw options to a non-Bedrock member",
  async ({ converse }) => {
    const { ask, aws, openai, anthropic } = converse;
    const guardrailConfig = {
      guardrailIdentifier: "synthetic-guard",
      guardrailVersion: "1",
    };
    const nativeOptions = {
      guardrailConfig,
      requestMetadata: { fixture: "synthetic" },
      performanceConfig: { latency: "optimized" },
      serviceTier: { type: "default" },
      additionalModelResponseFieldPaths: ["/synthetic"],
      additionalModelRequestFields: { synthetic: true },
      system: [
        { text: "Be concise." },
        { cachePoint: { type: "default", ttl: "5m" } },
      ],
    };
    aws.mockImplementationOnce(() =>
      HttpResponse.json({
        output: {
          message: { role: "assistant", content: [{ text: "blocked" }] },
        },
        stopReason: "guardrail_intervened",
        usage: { inputTokens: 4, outputTokens: 1 },
        additionalModelResponseFields: { synthetic: "present" },
      }),
    );
    const guarded = await ask(
      { ...request, ...nativeOptions },
      false,
      fallbackFirstName,
    );
    expect(guarded.statusCode, guarded.body).toBe(200);
    expect(guarded.json()).toMatchObject({
      stopReason: "guardrail_intervened",
      additionalModelResponseFields: { synthetic: "present" },
    });
    expect(aws).toHaveBeenCalledWith(expect.objectContaining(nativeOptions));
    // A failure on this request must not move it to either non-AWS member.
    const failure = await ask(
      { ...request, ...nativeOptions },
      false,
      fallbackFirstName,
    );
    expect(failure.statusCode, failure.body).toBe(503);
    expect(aws.mock.calls.length).toBeGreaterThanOrEqual(2);
    const hits = aws.mock.calls.length;

    // The installed AWS protocol supports strict enforcement, but our
    // native schema would strip it today; it must never run non-strict.
    const unknown = await ask(
      {
        ...request,
        toolConfig: { tools: [{ toolSpec: { ...toolSpec, strict: true } }] },
      },
      false,
      fallbackFirstName,
    );
    expect(unknown.statusCode, unknown.body).toBe(400);
    expect(unknown.json().error.message).toContain(
      "unrecognized native options",
    );
    expect(aws).toHaveBeenCalledTimes(hits);
    expect(openai).not.toHaveBeenCalled();
    expect(anthropic).not.toHaveBeenCalled();
  },
);

poolTest(
  "keeps the existing Bedrock-only Converse path for unrecognized fields",
  async ({ converse: { ask, aws } }) => {
    const output = {
      message: { role: "assistant", content: [{ text: "Native response" }] },
    };
    aws.mockImplementationOnce(() =>
      HttpResponse.json({
        output,
        stopReason: "end_turn",
        usage: { inputTokens: 4, outputTokens: 2 },
      }),
    );

    // The native schema has always stripped unrecognized fields like this.
    const response = await ask(
      { ...request, syntheticNativeOption: true },
      false,
      bedrockOnlyName,
    );

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({ output, stopReason: "end_turn" });
    expect(aws).toHaveBeenCalledOnce();
    expect(aws.mock.calls[0][0]).toMatchObject(request);
    expect(aws.mock.calls[0][0]).not.toHaveProperty("syntheticNativeOption");
  },
);

for (const stream of [false, true]) {
  poolTest(
    `preserves Anthropic stop sequences on Converse (stream=${stream})`,
    async ({ converse }) => {
      const message = {
        id: "msg_synthetic",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-4-6",
        content: [{ type: "text", text: "done" }],
        stop_reason: "stop_sequence",
        stop_sequence: "END",
        usage: { input_tokens: 7, output_tokens: 2 },
      };
      converse.anthropic.mockImplementation(() =>
        stream
          ? anthropicSse([
              {
                type: "message_start",
                message: {
                  ...message,
                  content: [],
                  stop_reason: null,
                  stop_sequence: null,
                },
              },
              {
                type: "content_block_start",
                index: 0,
                content_block: { type: "text", text: "" },
              },
              {
                type: "content_block_delta",
                index: 0,
                delta: { type: "text_delta", text: "done" },
              },
              { type: "content_block_stop", index: 0 },
              {
                type: "message_delta",
                delta: { stop_reason: "stop_sequence", stop_sequence: "END" },
                usage: { output_tokens: 2 },
              },
              { type: "message_stop" },
            ])
          : HttpResponse.json(message),
      );
      const response = await converse.ask(
        {
          messages: request.messages,
          inferenceConfig: { maxTokens: 32, stopSequences: ["END"] },
        },
        stream,
      );
      expect(response.statusCode, response.body).toBe(200);
      expect(converse.anthropic).toHaveBeenCalledWith(
        expect.objectContaining({ stop_sequences: ["END"] }),
      );
      if (stream) {
        expect(decodeFrames(response.rawPayload)).toContainEqual([
          "messageStop",
          { stopReason: "stop_sequence" },
        ]);
      } else {
        expect(response.json()).toMatchObject({ stopReason: "stop_sequence" });
      }
    },
  );
}
