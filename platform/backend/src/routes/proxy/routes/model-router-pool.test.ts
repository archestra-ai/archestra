import {
  CHAT_API_KEY_ID_HEADER,
  MODEL_POOL_ID_HEADER,
} from "@archestra/shared";
import { EventStreamCodec } from "@smithy/eventstream-codec";
import { fromUtf8, toUtf8 } from "@smithy/util-utf8";
import { HttpResponse, http } from "msw";
import client from "prom-client";
import { internalCallHeader } from "@/clients/internal-call";
import config from "@/config";
import db, { schema } from "@/database";
import {
  createFastifyInstance,
  type FastifyInstanceWithZod,
} from "@/fastify-instance";
import { ModelPoolModel, VirtualApiKeyModel } from "@/models";
import { initializeLlmProxyMetrics } from "@/observability/metrics/llm-proxy";
import { resolveVirtualKeyProviderMappings } from "@/services/virtual-key-providers";
import { accessGrants, beforeEach, expect, test } from "@/test";
import { setupTestCacheManager } from "@/test/cache-manager";
import { useMswServer } from "@/test/msw";
import modelRouterRoutes from "./model-router";
import openAiProxyRoutes from "./openai";

// Model pools are a beta feature; these tests run with it on.
beforeEach(() => {
  config.llmProxy.modelPoolsEnabled = true;
});

// One model on two providers: Z.ai answers on the OpenAI wire and Bedrock on
// Converse. The caller's virtual key holds neither key; the pool granted to it
// is enough. Only the HTTP upstreams are mocked.
// biome-ignore lint/correctness/useHookAtTopLevel: Vitest lifecycle helper.
const server = useMswServer();
setupTestCacheManager();
const codec = new EventStreamCodec(toUtf8, fromUtf8);
const zaiOrigin = "https://zai.example.test/api/paas/v4";
const bedrockOrigin = "https://bedrock.example.test";

const poolTest = test.extend<{
  router: {
    app: FastifyInstanceWithZod;
    agentId: string;
    organizationId: string;
    token: string;
    /** A virtual key in the same org that maps no member key and has no grant. */
    ungrantedToken: string;
    /** A virtual key that maps a member's key but wasn't given the pool. */
    memberKeyToken: string;
    poolId: string;
    zaiKeyId: string;
    bedrockKeyId: string;
  };
}>({
  router: async (
    { makeOrganization, makeAgent, makeSecret, makeLlmProviderApiKey },
    use,
  ) => {
    config.llm.bedrock.baseUrl = bedrockOrigin;
    config.llm.bedrock.iamAuthEnabled = false;
    const org = await makeOrganization();
    const agent = await makeAgent({
      organizationId: org.id,
      agentType: "agent",
    });
    const zai = await makeLlmProviderApiKey(
      org.id,
      (await makeSecret({ secret: { apiKey: "zai-key" } })).id,
      { provider: "zhipuai", baseUrl: zaiOrigin },
    );
    const bedrock = await makeLlmProviderApiKey(
      org.id,
      (await makeSecret({ secret: { apiKey: "bedrock-bearer" } })).id,
      { provider: "bedrock" },
    );
    const openai = await makeLlmProviderApiKey(
      org.id,
      (await makeSecret({ secret: { apiKey: "sk-unused" } })).id,
      { provider: "openai" },
    );
    const virtual = await VirtualApiKeyModel.create({
      organizationId: org.id,
      name: "OpenAI-only router key",
      ...accessGrants("org"),
      providerApiKeys: [{ provider: "openai", providerApiKeyId: openai.id }],
    });
    const pool = await ModelPoolModel.create({
      organizationId: org.id,
      input: {
        name: "glm-5",
        members: [
          {
            providerApiKeyId: zai.id,
            modelId: "glm-5",
            priority: 1,
            weight: 1,
            enabled: true,
          },
          {
            providerApiKeyId: bedrock.id,
            modelId: "zai.glm-5",
            priority: 2,
            weight: 1,
            enabled: true,
          },
        ],
      },
    });
    await ModelPoolModel.setPoolsForVirtualApiKey({
      organizationId: org.id,
      virtualApiKeyId: virtual.virtualKey.id,
      poolIds: [pool.id],
    });
    const ungranted = await VirtualApiKeyModel.create({
      organizationId: org.id,
      name: "Router key without the pool",
      ...accessGrants("org"),
      providerApiKeys: [{ provider: "openai", providerApiKeyId: openai.id }],
    });
    const memberKey = await VirtualApiKeyModel.create({
      organizationId: org.id,
      name: "Connect key",
      ...accessGrants("org"),
      providerApiKeys: [{ provider: "zhipuai", providerApiKeyId: zai.id }],
    });
    const app = createFastifyInstance();
    await app.register(modelRouterRoutes);
    await app.register(openAiProxyRoutes);
    try {
      await use({
        app,
        agentId: agent.id,
        organizationId: org.id,
        token: virtual.value,
        ungrantedToken: ungranted.value,
        memberKeyToken: memberKey.value,
        poolId: pool.id,
        zaiKeyId: zai.id,
        bedrockKeyId: bedrock.id,
      });
    } finally {
      await app.close();
    }
  },
});

poolTest("lists the pool's name first", async ({ router }) => {
  const response = await router.app.inject({
    method: "GET",
    url: `/v1/model-router/${router.agentId}/models`,
    headers: { authorization: `Bearer ${router.token}` },
  });
  expect(response.statusCode, response.body).toBe(200);
  expect(response.json().data[0]).toMatchObject({
    id: "glm-5",
    owned_by: "model-pool",
  });
});

poolTest(
  "keeps the pool from a virtual key it isn't granted to",
  async ({ router }) => {
    let zaiCalls = 0;
    server.use(
      http.post(`${zaiOrigin}/chat/completions`, () => {
        zaiCalls++;
        return HttpResponse.json({}, { status: 500 });
      }),
    );
    const models = await router.app.inject({
      method: "GET",
      url: `/v1/model-router/${router.agentId}/models`,
      headers: { authorization: `Bearer ${router.ungrantedToken}` },
    });
    expect(models.statusCode, models.body).toBe(200);
    expect(
      models
        .json()
        .data.filter((m: { owned_by: string }) => m.owned_by === "model-pool"),
    ).toEqual([]);

    // Asking for the pool's name doesn't reach it.
    const response = await router.app.inject({
      method: "POST",
      url: `/v1/model-router/${router.agentId}/chat/completions`,
      headers: { authorization: `Bearer ${router.ungrantedToken}` },
      payload: {
        model: "glm-5",
        messages: [{ role: "user", content: "hello" }],
      },
    });
    expect(response.headers["x-archestra-pool"]).toBeUndefined();
    expect(response.statusCode).toBeGreaterThanOrEqual(400);
    expect(zaiCalls).toBe(0);
  },
);

poolTest(
  "keeps the pool from a virtual key that only maps a member's key",
  async ({ router }) => {
    server.use(
      http.post(`${zaiOrigin}/chat/completions`, () =>
        HttpResponse.json({
          id: "chatcmpl-1",
          object: "chat.completion",
          created: 1,
          model: "glm-5",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "hi" },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 9, completion_tokens: 2, total_tokens: 11 },
        }),
      ),
    );
    const models = await router.app.inject({
      method: "GET",
      url: `/v1/model-router/${router.agentId}/models`,
      headers: { authorization: `Bearer ${router.memberKeyToken}` },
    });
    expect(models.statusCode, models.body).toBe(200);
    expect(
      models
        .json()
        .data.filter((m: { owned_by: string }) => m.owned_by === "model-pool"),
    ).toEqual([]);

    const response = await router.app.inject({
      method: "POST",
      url: `/v1/model-router/${router.agentId}/chat/completions`,
      headers: { authorization: `Bearer ${router.memberKeyToken}` },
      payload: {
        model: "glm-5",
        messages: [{ role: "user", content: "hello" }],
      },
    });
    expect(response.headers["x-archestra-pool"]).toBeUndefined();
  },
);

poolTest(
  "serves a granted pool to a key that resolves to no provider key",
  async ({ router }) => {
    server.use(
      http.post(`${zaiOrigin}/chat/completions`, () =>
        HttpResponse.json({
          id: "chatcmpl-1",
          object: "chat.completion",
          created: 1,
          model: "glm-5",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "hi" },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 9, completion_tokens: 2, total_tokens: 11 },
        }),
      ),
    );
    // Current and future providers, in an org whose keys aren't primaries:
    // the key resolves to no provider key and only has the pool.
    const automatic = await VirtualApiKeyModel.create({
      organizationId: router.organizationId,
      name: "Pool-only automatic key",
      ...accessGrants("org"),
      providerApiKeys: [],
      includeFutureProviders: true,
    });
    await ModelPoolModel.setPoolsForVirtualApiKey({
      organizationId: router.organizationId,
      virtualApiKeyId: automatic.virtualKey.id,
      poolIds: [router.poolId],
    });
    expect(
      await resolveVirtualKeyProviderMappings(automatic.virtualKey.id),
    ).toEqual([]);

    const response = await router.app.inject({
      method: "POST",
      url: `/v1/model-router/${router.agentId}/chat/completions`,
      headers: { authorization: `Bearer ${automatic.value}` },
      payload: {
        model: "glm-5",
        messages: [{ role: "user", content: "hello" }],
      },
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.headers["x-archestra-pool"]).toBe("glm-5");
  },
);

for (const stream of [false, true]) {
  poolTest(
    `fails over from Z.ai to Bedrock by the pool's name (stream: ${stream})`,
    async ({ router }) => {
      initializeLlmProxyMetrics();
      const histogram = client.register.getSingleMetric(
        "llm_proxy_request_duration_seconds",
      ) as client.Histogram;
      histogram.reset();
      let zaiCalls = 0;
      let bedrockModel: string | undefined;
      server.use(
        http.post(`${zaiOrigin}/chat/completions`, () => {
          zaiCalls++;
          return HttpResponse.json(
            { error: { message: "Rate limit reached", code: "1302" } },
            { status: 429, headers: { "retry-after": "20" } },
          );
        }),
        http.post(
          `${bedrockOrigin}/model/:model/${stream ? "converse-stream" : "converse"}`,
          ({ params }) => {
            bedrockModel = decodeURIComponent(String(params.model));
            const usage = { inputTokens: 9, outputTokens: 2, totalTokens: 11 };
            if (!stream) {
              return HttpResponse.json({
                output: {
                  message: { role: "assistant", content: [{ text: "hi" }] },
                },
                stopReason: "end_turn",
                usage,
              });
            }
            return new HttpResponse(
              binaryEvents([
                ["messageStart", { role: "assistant" }],
                [
                  "contentBlockDelta",
                  { contentBlockIndex: 0, delta: { text: "hi" } },
                ],
                ["contentBlockStop", { contentBlockIndex: 0 }],
                ["messageStop", { stopReason: "end_turn" }],
                ["metadata", { usage, metrics: { latencyMs: 1 } }],
              ]),
              {
                headers: {
                  "content-type": "application/vnd.amazon.eventstream",
                },
              },
            );
          },
        ),
      );

      const response = await router.app.inject({
        method: "POST",
        url: `/v1/model-router/${router.agentId}/chat/completions`,
        headers: { authorization: `Bearer ${router.token}` },
        payload: {
          model: "glm-5",
          stream,
          messages: [{ role: "user", content: "hello" }],
        },
      });

      expect(response.statusCode, response.body).toBe(200);
      const counts = (await histogram.get()).values.filter((value) =>
        value.metricName?.endsWith("_count"),
      );
      expect(counts).toEqual([
        expect.objectContaining({
          value: 1,
          labels: expect.objectContaining({
            provider: "bedrock",
            outcome: "success",
            stream: String(stream),
          }),
        }),
      ]);
      expect(zaiCalls).toBeGreaterThan(0);
      expect(bedrockModel).toBe("zai.glm-5");
      expect(response.headers["x-archestra-pool"]).toBe("glm-5");
      expect(response.headers["x-archestra-attempts"]).toBe("2");
      expect(response.headers["x-archestra-provider-key"]).toBe(
        router.bedrockKeyId,
      );
      const text = stream
        ? response.body
            .split("\n")
            .filter((line) => line.startsWith("data: {"))
            .map((line) => JSON.parse(line.slice(6)))
            .map((chunk) => chunk.choices?.[0]?.delta?.content ?? "")
            .join("")
        : response.json().choices[0].message.content;
      expect(text).toBe("hi");

      const rows = await db
        .select()
        .from(schema.interactionsTable)
        .orderBy(schema.interactionsTable.attempt);
      expect(
        rows.map((row) => ({
          providerApiKeyId: row.providerApiKeyId,
          modelPoolId: row.modelPoolId,
          model: row.model,
          attemptOutcome: row.attemptOutcome,
        })),
      ).toEqual([
        {
          providerApiKeyId: router.zaiKeyId,
          modelPoolId: router.poolId,
          model: "glm-5",
          attemptOutcome: "failed_over",
        },
        {
          providerApiKeyId: router.bedrockKeyId,
          modelPoolId: router.poolId,
          model: "zai.glm-5",
          attemptOutcome: "answered",
        },
      ]);
    },
  );
}

function binaryEvents(events: Array<[string, unknown]>): Uint8Array {
  const parts = events.map(([type, body]) =>
    codec.encode({
      headers: {
        ":event-type": { type: "string", value: type },
        ":content-type": { type: "string", value: "application/json" },
        ":message-type": { type: "string", value: "event" },
      },
      body: fromUtf8(JSON.stringify(body)),
    }),
  );
  const result = new Uint8Array(parts.reduce((sum, p) => sum + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

const responsesPoolTest = poolTest.extend<{
  native: { firstKeyId: string; secondKeyId: string };
}>({
  native: async ({ router, makeSecret, makeLlmProviderApiKey }, use) => {
    const keys = [];
    for (const [name, provider] of [
      ["primary", "openai"],
      ["backup", "azure"],
    ] as const) {
      keys.push(
        await makeLlmProviderApiKey(
          router.organizationId,
          (await makeSecret({ secret: { apiKey: `fixture-${name}` } })).id,
          {
            provider,
            baseUrl: `https://${name}.responses.example.test/openai/v1`,
          },
        ),
      );
    }
    await ModelPoolModel.update({
      organizationId: router.organizationId,
      id: router.poolId,
      input: {
        name: "glm-5",
        members: keys.map((key, index) => ({
          providerApiKeyId: key.id,
          modelId: `gpt-4.1-${index}`,
          priority: index,
          weight: 1,
          enabled: true,
        })),
      },
    });
    await use({ firstKeyId: keys[0].id, secondKeyId: keys[1].id });
  },
});

const responsesInput = [
  {
    type: "reasoning",
    id: "rs_fixture",
    summary: [],
    encrypted_content: "synthetic-replay",
  },
  {
    type: "function_call",
    call_id: "call_fixture",
    name: "lookup",
    arguments: "{}",
  },
  {
    type: "function_call_output",
    call_id: "call_fixture",
    output: "fixture result",
  },
  { role: "user", content: [{ type: "input_text", text: "Continue" }] },
];
const responsesOutput = [
  {
    type: "reasoning",
    id: "rs_answer",
    summary: [{ type: "summary_text", text: "Checking" }],
    encrypted_content: "synthetic-answer",
  },
  {
    type: "function_call",
    id: "fc_answer",
    call_id: "call_answer",
    name: "lookup",
    arguments: "{}",
    status: "completed",
  },
];
function nativeResponse(id = "resp_backup") {
  return {
    id,
    object: "response",
    created_at: 1,
    status: "completed",
    model: "gpt-4.1-1",
    output: responsesOutput,
    usage: {
      input_tokens: 20,
      input_tokens_details: { cached_tokens: 6 },
      output_tokens: 8,
      output_tokens_details: { reasoning_tokens: 3 },
      total_tokens: 28,
    },
  };
}
function responsesSse(events: unknown[]) {
  const bytes = new TextEncoder().encode(
    events
      .map(
        (event) =>
          `event: ${(event as { type: string }).type}\ndata: ${JSON.stringify(event)}\n\n`,
      )
      .join(""),
  );
  return new HttpResponse(
    new ReadableStream({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  );
}

function responsesPayload(stream: boolean) {
  return {
    model: "glm-5",
    stream,
    input: responsesInput,
    instructions: "Use the tool",
    reasoning: { effort: "low", summary: "auto" },
    include: ["reasoning.encrypted_content"],
    store: false,
    max_output_tokens: 128,
    tools: [
      {
        type: "function",
        name: "lookup",
        parameters: { type: "object", properties: {} },
        strict: true,
      },
    ],
  };
}

for (const stream of [false, true]) {
  responsesPoolTest(
    `Responses preserves native state and accounts for OpenAI to Azure failover (stream: ${stream})`,
    async ({ router, native }) => {
      const received: Record<string, unknown>[] = [];
      server.use(
        http.post(
          "https://primary.responses.example.test/openai/v1/responses",
          async ({ request }) => {
            received.push((await request.json()) as Record<string, unknown>);
            return HttpResponse.json(
              {
                error: {
                  message: "fixture rate limit",
                  code: "rate_limit_exceeded",
                },
              },
              { status: 429 },
            );
          },
        ),
        http.post(
          "https://backup.responses.example.test/openai/v1/responses",
          async ({ request }) => {
            received.push((await request.json()) as Record<string, unknown>);
            const response = nativeResponse();
            return stream
              ? responsesSse([
                  {
                    type: "response.created",
                    sequence_number: 0,
                    response: {
                      ...response,
                      status: "in_progress",
                      output: [],
                      usage: null,
                    },
                  },
                  ...responsesOutput.map((item, output_index) => ({
                    type: "response.output_item.done",
                    sequence_number: output_index + 1,
                    output_index,
                    item,
                  })),
                  { type: "response.completed", sequence_number: 3, response },
                ])
              : HttpResponse.json(response);
          },
        ),
      );
      const payload = responsesPayload(stream);
      const result = await router.app.inject({
        method: "POST",
        url: `/v1/model-router/${router.agentId}/responses`,
        headers: { authorization: `Bearer ${router.token}` },
        payload,
      });
      expect(result.statusCode, result.body).toBe(200);
      expect(result.headers["x-archestra-pool"]).toBe("glm-5");
      expect(result.headers["x-archestra-attempts"]).toBe("2");
      expect(result.headers["x-archestra-provider-key"]).toBe(
        native.secondKeyId,
      );
      expect(received).toEqual([
        { ...payload, model: "gpt-4.1-0" },
        { ...payload, model: "gpt-4.1-1" },
      ]);
      const events = stream
        ? result.body
            .split("\n")
            .filter((line) => line.startsWith("data: {"))
            .map((line) => JSON.parse(line.slice(6)))
        : [];
      const answer = stream
        ? events.find((event) => event.type === "response.completed")?.response
        : result.json();
      expect(answer.output).toEqual(responsesOutput);
      expect(answer.usage).toMatchObject(nativeResponse().usage);
      if (stream)
        expect(
          events.filter((event) => event.type === "response.completed"),
        ).toHaveLength(1);
      const rows = await db
        .select()
        .from(schema.interactionsTable)
        .orderBy(schema.interactionsTable.attempt);
      expect(rows).toMatchObject([
        {
          providerApiKeyId: native.firstKeyId,
          modelPoolId: router.poolId,
          model: "gpt-4.1-0",
          attemptOutcome: "failed_over",
        },
        {
          providerApiKeyId: native.secondKeyId,
          modelPoolId: router.poolId,
          model: "gpt-4.1-1",
          attemptOutcome: "answered",
          inputTokens: 14,
          outputTokens: 8,
          cacheReadTokens: 6,
        },
      ]);
    },
  );
}

for (const afterOutput of [false, true]) {
  responsesPoolTest(
    `Responses only fails over before output (afterOutput: ${afterOutput})`,
    async ({ router, native }) => {
      let backupCalls = 0;
      server.use(
        http.post(
          "https://primary.responses.example.test/openai/v1/responses",
          () =>
            responsesSse([
              {
                type: "response.created",
                sequence_number: 0,
                response: {
                  ...nativeResponse("resp_primary"),
                  status: "in_progress",
                  output: [],
                  usage: null,
                },
              },
              ...(afterOutput
                ? [
                    {
                      type: "response.output_text.delta",
                      sequence_number: 1,
                      item_id: "msg_primary",
                      output_index: 0,
                      content_index: 0,
                      delta: "Partial",
                      logprobs: [],
                    },
                  ]
                : []),
              // Close without a terminal event, after either lifecycle or actual output.
            ]),
        ),
        http.post(
          "https://backup.responses.example.test/openai/v1/responses",
          () => {
            backupCalls++;
            return responsesSse([
              {
                type: "response.completed",
                sequence_number: 0,
                response: { ...nativeResponse(), output: [] },
              },
            ]);
          },
        ),
      );
      const result = await router.app.inject({
        method: "POST",
        url: `/v1/model-router/${router.agentId}/responses`,
        headers: { authorization: `Bearer ${router.token}` },
        payload: responsesPayload(true),
      });
      expect(result.statusCode, result.body).toBe(200);
      expect(backupCalls).toBe(afterOutput ? 0 : 1);
      expect(result.body.includes("resp_primary")).toBe(afterOutput);
      expect(result.body).toContain(
        afterOutput ? '"response.failed"' : '"response.completed"',
      );
      const rows = await db
        .select()
        .from(schema.interactionsTable)
        .orderBy(schema.interactionsTable.attempt);
      expect(rows.at(-1)?.attemptOutcome).toBe(
        afterOutput ? "failed" : "answered",
      );
      expect(rows.at(-1)?.providerApiKeyId).toBe(
        afterOutput ? native.firstKeyId : native.secondKeyId,
      );
    },
  );
}

for (const stream of [false, true]) {
  for (const failure of [
    "transient",
    "invalid",
    "usage",
    ...(stream ? ["after-output"] : []),
  ]) {
    responsesPoolTest(
      `Responses terminal failure is safe and accounted (stream: ${stream}, failure: ${failure})`,
      async ({ router, native }) => {
        let backupCalls = 0;
        const response = {
          ...nativeResponse("resp_primary"),
          status: "failed",
          output: [],
          usage: failure === "usage" ? nativeResponse().usage : null,
          error: {
            code: failure === "invalid" ? "invalid_prompt" : "server_error",
            message: "fixture generation failure",
          },
        };
        server.use(
          http.post(
            "https://primary.responses.example.test/openai/v1/responses",
            () =>
              stream
                ? responsesSse([
                    {
                      type: "response.created",
                      sequence_number: 0,
                      response: {
                        ...response,
                        status: "in_progress",
                        usage: null,
                        error: null,
                      },
                    },
                    ...(failure === "after-output"
                      ? [
                          {
                            type: "response.output_text.delta",
                            sequence_number: 1,
                            item_id: "msg_primary",
                            output_index: 0,
                            content_index: 0,
                            delta: "Partial",
                            logprobs: [],
                          },
                        ]
                      : []),
                    { type: "response.failed", sequence_number: 2, response },
                  ])
                : HttpResponse.json(response),
          ),
          http.post(
            "https://backup.responses.example.test/openai/v1/responses",
            () => {
              backupCalls++;
              return stream
                ? responsesSse([
                    {
                      type: "response.completed",
                      sequence_number: 0,
                      response: nativeResponse(),
                    },
                  ])
                : HttpResponse.json(nativeResponse());
            },
          ),
        );
        const result = await router.app.inject({
          method: "POST",
          url: `/v1/model-router/${router.agentId}/responses`,
          headers: { authorization: `Bearer ${router.token}` },
          payload: responsesPayload(stream),
        });
        expect(result.statusCode, result.body).toBe(200);
        const failedOver = failure === "transient";
        expect(backupCalls).toBe(failedOver ? 1 : 0);
        expect(result.body.includes("resp_primary")).toBe(!failedOver);
        const rows = await db
          .select()
          .from(schema.interactionsTable)
          .orderBy(schema.interactionsTable.attempt);
        expect(rows).toHaveLength(failedOver ? 2 : 1);
        expect(rows.at(-1)).toMatchObject({
          providerApiKeyId: failedOver ? native.secondKeyId : native.firstKeyId,
          attemptOutcome: failedOver ? "answered" : "failed",
        });
        if (failedOver) expect(rows[0].attemptOutcome).toBe("failed_over");
        if (failure === "usage")
          expect(rows[0]).toMatchObject({
            inputTokens: 14,
            cacheReadTokens: 6,
            outputTokens: 8,
          });
      },
    );
  }
}

responsesPoolTest(
  "Responses refuses stored account state and ungranted pool access before upstream",
  async ({ router, native }) => {
    for (const extra of [
      { previous_response_id: "resp_previous" },
      { conversation: "conv_previous" },
      { background: true },
      { input: [{ type: "item_reference", id: "msg_stored" }] },
      { tools: [{ type: "file_search", vector_store_ids: ["vs_stored"] }] },
    ]) {
      const result = await router.app.inject({
        method: "POST",
        url: `/v1/model-router/${router.agentId}/responses`,
        headers: { authorization: `Bearer ${router.token}` },
        payload: { ...responsesPayload(false), ...extra },
      });
      expect(result.statusCode, result.body).toBe(400);
      expect(result.body).toContain("complete Responses input history");
    }
    const result = await router.app.inject({
      method: "POST",
      url: `/v1/model-router/${router.agentId}/responses`,
      headers: { authorization: `Bearer ${router.ungrantedToken}` },
      payload: responsesPayload(false),
    });
    expect(result.statusCode, result.body).not.toBe(200);
    expect(result.headers["x-archestra-pool"]).toBeUndefined();
    expect(result.headers["x-archestra-provider-key"]).not.toBe(
      native.firstKeyId,
    );
  },
);

poolTest(
  "Responses rejects a pool with incompatible member wires instead of dropping native state",
  async ({ router }) => {
    const result = await router.app.inject({
      method: "POST",
      url: `/v1/model-router/${router.agentId}/responses`,
      headers: { authorization: `Bearer ${router.token}` },
      payload: responsesPayload(false),
    });
    expect(result.statusCode, result.body).toBe(400);
    expect(result.body).toContain("cannot serve openai-responses");
  },
);

responsesPoolTest(
  "a platform Responses call uses a pool only when explicitly selected",
  async ({ router, native }) => {
    config.llm.openai.baseUrl =
      "https://primary.responses.example.test/openai/v1";
    server.use(
      http.post(
        "https://primary.responses.example.test/openai/v1/responses",
        () =>
          HttpResponse.json(
            { error: { message: "fixture rate limit" } },
            { status: 429 },
          ),
      ),
      http.post(
        "https://backup.responses.example.test/openai/v1/responses",
        () => HttpResponse.json(nativeResponse()),
      ),
    );
    const post = (pooled: boolean) =>
      router.app.inject({
        method: "POST",
        url: `/v1/openai/${router.agentId}/responses`,
        remoteAddress: "127.0.0.1",
        headers: {
          ...internalCallHeader(),
          authorization: "Bearer fixture-primary",
          [CHAT_API_KEY_ID_HEADER]: native.firstKeyId,
          ...(pooled ? { [MODEL_POOL_ID_HEADER]: router.poolId } : {}),
        },
        payload: { ...responsesPayload(false), model: "gpt-4.1-0" },
      });
    expect((await post(false)).statusCode).toBe(429);
    const pooled = await post(true);
    expect(pooled.statusCode, pooled.body).toBe(200);
    expect(pooled.headers["x-archestra-provider-key"]).toBe(native.secondKeyId);
  },
);

test("Copilot pool uses the owner's subscription on both APIs without sharing it through pool grants", async ({
  makeOrganization,
  makeUser,
  makeMember,
  makeAgent,
  makeSecret,
  makeLlmProviderApiKey,
}) => {
  const org = await makeOrganization();
  const owner = await makeUser();
  const other = await makeUser();
  await makeMember(owner.id, org.id);
  await makeMember(other.id, org.id);
  const agent = await makeAgent({ organizationId: org.id, agentType: "agent" });
  const githubToken = `gho_${crypto.randomUUID()}`;
  const key = await makeLlmProviderApiKey(
    org.id,
    (await makeSecret({ secret: { apiKey: githubToken } })).id,
    { provider: "github-copilot", userId: owner.id },
  );
  const pool = await ModelPoolModel.create({
    organizationId: org.id,
    input: {
      name: "copilot-pool",
      members: [
        {
          providerApiKeyId: key.id,
          modelId: "gpt-4.1",
          priority: 1,
          weight: 1,
          enabled: true,
        },
      ],
    },
  });
  let exchanges = 0;
  let completions = 0;
  let responses = 0;
  const upstream = "https://copilot-pool.example.test";
  server.use(
    http.get(config.llm["github-copilot"].tokenExchangeUrl, ({ request }) => {
      expect(request.headers.get("authorization")).toBe(`token ${githubToken}`);
      exchanges++;
      return HttpResponse.json({
        token: "copilot-session",
        expires_at: Math.floor(Date.now() / 1000) + 1800,
        endpoints: { api: upstream },
      });
    }),
    http.post(`${upstream}/chat/completions`, async ({ request }) => {
      expect(request.headers.get("authorization")).toBe(
        "Bearer copilot-session",
      );
      expect(await request.json()).toMatchObject({ model: "gpt-4.1" });
      completions++;
      return HttpResponse.json({
        id: "completion",
        object: "chat.completion",
        created: 1,
        model: "gpt-4.1",
        choices: [
          {
            message: { role: "assistant", content: "OK" },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
      });
    }),
    http.post(`${upstream}/responses`, async ({ request }) => {
      expect(request.headers.get("authorization")).toBe(
        "Bearer copilot-session",
      );
      expect(await request.json()).toMatchObject({ model: "gpt-4.1" });
      responses++;
      return HttpResponse.json({
        id: "response",
        object: "response",
        created_at: 1,
        status: "completed",
        model: "gpt-4.1",
        output: [
          {
            type: "message",
            id: "message",
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text: "OK", annotations: [] }],
          },
        ],
        usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 },
      });
    }),
  );
  const app = createFastifyInstance();
  await app.register(modelRouterRoutes);
  try {
    for (const authorId of [owner.id, other.id, null]) {
      const virtual = await VirtualApiKeyModel.create({
        organizationId: org.id,
        name: "Pool caller",
        scope: authorId ? "personal" : "org",
        authorId,
        includeFutureProviders: true,
      });
      await ModelPoolModel.setPoolsForVirtualApiKey({
        organizationId: org.id,
        virtualApiKeyId: virtual.virtualKey.id,
        poolIds: [pool.id],
      });
      for (const endpoint of ["chat/completions", "responses"]) {
        const result = await app.inject({
          method: "POST",
          url: `/v1/model-router/${agent.id}/${endpoint}`,
          headers: {
            authorization: `Bearer ${virtual.value}`,
            "x-archestra-user-id": owner.id,
          },
          payload: {
            model: pool.name,
            ...(endpoint === "responses"
              ? {
                  input: [{ role: "user", content: "Hello" }],
                  max_output_tokens: 16,
                }
              : {
                  messages: [{ role: "user", content: "Hello" }],
                  max_tokens: 16,
                }),
          },
        });
        expect(result.statusCode, result.body).toBe(
          authorId === owner.id ? 200 : 403,
        );
        if (authorId === owner.id) {
          expect(result.headers["x-archestra-pool"]).toBe(pool.name);
          expect(result.headers["x-archestra-provider-key"]).toBe(key.id);
          expect(result.body).toContain("OK");
          if (endpoint === "chat/completions")
            expect(result.json().choices[0].index).toBe(0);
        }
      }
    }
    expect(exchanges).toBe(1);
    expect(completions).toBe(1);
    expect(responses).toBe(1);
  } finally {
    await app.close();
  }
});
