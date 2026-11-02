import { HttpResponse, http } from "msw";
import { modelsDevClient } from "@/clients/models-dev-client";
import config from "@/config";
import { createFastifyInstance } from "@/fastify-instance";
import InteractionModel from "@/models/interaction";
import LimitModel from "@/models/limit";
import ModelModel from "@/models/model";
import ResourcePermissionPolicyModel from "@/models/resource-permission-policy";
import { describe, expect, test } from "@/test";
import { makePassthroughCredential } from "@/test/llm-proxy-credentials";
import { useMswServer } from "@/test/msw";
import openaiProxyRoutes from "./openai";
import vllmProxyRoutes from "./vllm";

const upstreamUrl = "http://vllm.example.test/v1";
const toolCall = {
  id: "call_weather",
  type: "function",
  function: { name: "weather", arguments: '{"city":"Example City"}' },
};

// biome-ignore lint/correctness/useHookAtTopLevel: per-test MSW lifecycle helper
const server = useMswServer();

describe("vLLM proxy response serialization", () => {
  test.for([
    { name: "null", toolCalls: null },
    { name: "omitted", toolCalls: undefined },
    { name: "empty", toolCalls: [] },
    { name: "populated", toolCalls: [toolCall] },
  ])("round-trips $name tool calls", async ({ toolCalls }, {
    makeAgent,
    makeMember,
    makeUser,
  }) => {
    config.llm.vllm.enabled = true;
    config.llm.vllm.baseUrl = upstreamUrl;
    const agent = await makeAgent({ agentType: "llm_proxy" });
    const owner = await makeUser();
    await makeMember(owner.id, agent.organizationId);
    const passthroughToken = await makePassthroughCredential({
      organizationId: agent.organizationId,
      ownerId: owner.id,
    });
    const app = createFastifyInstance();
    await app.register(vllmProxyRoutes);

    const message = {
      role: "assistant",
      content: toolCalls?.length ? null : "Hello from a synthetic model.",
      ...(toolCalls === undefined ? {} : { tool_calls: toolCalls }),
    };
    let upstreamMessages: unknown;
    server.use(
      http.post(`${upstreamUrl}/chat/completions`, async ({ request }) => {
        upstreamMessages = ((await request.json()) as { messages: unknown })
          .messages;
        return HttpResponse.json({
          id: "chatcmpl-synthetic",
          object: "chat.completion",
          created: 1700000000,
          model: "synthetic-model",
          choices: [
            {
              index: 0,
              finish_reason: toolCalls?.length ? "tool_calls" : "stop",
              logprobs: null,
              message,
            },
          ],
          usage: { prompt_tokens: 5, completion_tokens: 4, total_tokens: 9 },
        });
      }),
    );

    try {
      const messages: Record<string, unknown>[] = [
        { role: "user", content: "Say hello." },
      ];
      const request = {
        method: "POST",
        url: `/v1/vllm/${agent.id}/chat/completions`,
        headers: {
          authorization: "Bearer synthetic-test-key",
          "x-archestra-virtual-key": passthroughToken,
        },
        payload: {
          model: "synthetic-model",
          messages,
          ...(toolCalls?.length
            ? {
                tools: [
                  {
                    type: "function",
                    function: {
                      name: "weather",
                      parameters: {
                        type: "object",
                        properties: { city: { type: "string" } },
                      },
                    },
                  },
                ],
              }
            : {}),
        },
      } as const;
      const response = await app.inject(request);

      expect(response.statusCode, response.body).toBe(200);
      expect(response.json().choices[0].message).toEqual(message);
      expect(response.json().usage.total_tokens).toBe(9);
      expect(upstreamMessages).toEqual(messages);

      messages.push(response.json().choices[0].message);
      if (toolCalls?.length) {
        messages.push({
          role: "tool",
          tool_call_id: toolCall.id,
          content: "Sunny.",
        });
      }
      messages.push({ role: "user", content: "Please continue." });
      const followUp = await app.inject(request);
      expect(followUp.statusCode, followUp.body).toBe(200);
      expect(upstreamMessages).toEqual(messages);
      expect(followUp.json().choices[0].message).toEqual(message);
    } finally {
      await app.close();
    }
  });
});

describe("Fireworks through a vLLM-compatible endpoint", () => {
  test.for(
    [
      { provider: "vllm" as const, restricted: false },
      { provider: "vllm" as const, restricted: true },
      { provider: "openai" as const, restricted: false },
      { provider: "openai" as const, restricted: true },
    ].flatMap((entry) =>
      entry.restricted
        ? [{ ...entry, stream: false, shortBudget: false }]
        : [false, true].flatMap((stream) =>
            [false, true].map((shortBudget) => ({
              ...entry,
              stream,
              shortBudget,
            })),
          ),
    ),
  )("canonical and pinned alias share prices and access ($provider, restricted=$restricted, stream=$stream, shortBudget=$shortBudget)", async ({
    provider,
    restricted,
    stream,
    shortBudget,
  }, { makeAgent, makeUser, makeMember }) => {
    const baseUrl = "https://api.fireworks.ai/inference/v1";
    const canonical = "accounts/fireworks/models/glm-5p3-flash";
    config.llm.vllm.enabled = true;
    config.llm[provider].baseUrl = baseUrl;
    const agent = await makeAgent({ agentType: "llm_proxy" });
    const owner = await makeUser();
    await makeMember(owner.id, agent.organizationId);
    const token = await makePassthroughCredential({
      organizationId: agent.organizationId,
      ownerId: owner.id,
    });
    const model = await ModelModel.create({
      externalId: `${provider}/${canonical}`,
      provider,
      modelId: canonical,
      inputModalities: ["text"],
      outputModalities: ["text"],
      customPricePerMillionInput: "1",
      customPricePerMillionOutput: "5",
      customPricePerMillionCacheRead: "0.25",
    });
    if (restricted) {
      const key = {
        organizationId: agent.organizationId,
        resource: "llmModel" as const,
        scope: model.id,
      };
      const current = await ResourcePermissionPolicyModel.find(key);
      await ResourcePermissionPolicyModel.replace({
        ...key,
        revision: current?.revision ?? 0,
        grants: [],
      });
    }
    const cap = await LimitModel.create({
      entityType: "organization",
      entityId: agent.organizationId,
      limitType: "token_cost",
      limitValue: 1,
      model: [shortBudget ? "glm-5p3-flash" : canonical],
    });
    modelsDevClient.clearFetchCache();
    let upstreamCalls = 0;
    server.use(
      http.get("https://models.dev/api.json", () => HttpResponse.json({})),
      http.post(`${baseUrl}/chat/completions`, async ({ request }) => {
        expect(((await request.json()) as { model: string }).model).toBe(
          canonical,
        );
        upstreamCalls++;
        if (stream) {
          const usage = {
            prompt_tokens: 1400,
            completion_tokens: 500,
            total_tokens: 1900,
            prompt_tokens_details: { cached_tokens: 400 },
          };
          const events = [
            {
              choices: [
                {
                  index: 0,
                  delta: { role: "assistant", content: "Fixture answer" },
                  finish_reason: null,
                },
              ],
            },
            { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
            { choices: [], usage },
          ]
            .map(
              (event) =>
                `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: canonical, ...event })}\n\n`,
            )
            .join("");
          return new HttpResponse(`${events}data: [DONE]\n\n`, {
            headers: { "Content-Type": "text/event-stream" },
          });
        }
        return HttpResponse.json({
          id: "fixture",
          object: "chat.completion",
          created: 1,
          model: canonical,
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "Fixture answer" },
              finish_reason: "stop",
            },
          ],
          usage: {
            prompt_tokens: 1400,
            completion_tokens: 500,
            total_tokens: 1900,
            prompt_tokens_details: { cached_tokens: 400 },
          },
        });
      }),
    );
    const app = createFastifyInstance();
    await app.register(
      provider === "vllm" ? vllmProxyRoutes : openaiProxyRoutes,
    );
    try {
      for (const requested of [canonical, "glm-5p3-flash"]) {
        const response = await app.inject({
          method: "POST",
          url: `/v1/${provider}/${agent.id}/chat/completions`,
          headers: {
            authorization: "Bearer synthetic-test-key",
            "x-archestra-virtual-key": token,
          },
          payload: {
            model: requested,
            stream,
            messages: [{ role: "user", content: "Fixture request" }],
          },
        });
        expect(response.statusCode, response.body).toBe(restricted ? 403 : 200);
        if (!restricted) {
          const logged = await InteractionModel.findAllPaginated({
            limit: 1,
            offset: 0,
          });
          expect(logged.data[0].model).toBe(canonical);
          expect(Number(logged.data[0].cost)).toBeCloseTo(0.0036, 10);
        }
      }
      expect(upstreamCalls).toBe(restricted ? 0 : 2);
      if (!restricted) {
        const usage = (await LimitModel.getModelUsageBreakdowns([cap.id])).get(
          cap.id,
        );
        expect(
          usage?.find((entry) => entry.model === canonical)?.cost,
        ).toBeCloseTo(0.0072, 10);
        await LimitModel.create({
          entityType: "organization",
          entityId: agent.organizationId,
          limitType: "token_cost",
          limitValue: 0,
          model: [shortBudget ? "glm-5p3-flash" : canonical],
        });
        for (const requested of [canonical, "glm-5p3-flash"]) {
          const refused = await app.inject({
            method: "POST",
            url: `/v1/${provider}/${agent.id}/chat/completions`,
            headers: {
              authorization: "Bearer synthetic-test-key",
              "x-archestra-virtual-key": token,
            },
            payload: {
              model: requested,
              stream,
              messages: [{ role: "user", content: "Fixture request" }],
            },
          });
          expect(refused.statusCode, refused.body).toBe(402);
        }
        expect(upstreamCalls).toBe(2);
      }
    } finally {
      await app.close();
      modelsDevClient.clearFetchCache();
    }
  });
});

test.for([
  "none",
  "budget",
  "access",
] as const)("opaque Fireworks router respects $0 controls", async (control, {
  makeAgent,
  makeMember,
  makeUser,
}) => {
  const baseUrl = "https://api.fireworks.ai/inference/v1";
  config.llm.vllm.enabled = true;
  config.llm.vllm.baseUrl = baseUrl;
  const agent = await makeAgent({ agentType: "llm_proxy" });
  const owner = await makeUser();
  await makeMember(owner.id, agent.organizationId);
  const token = await makePassthroughCredential({
    organizationId: agent.organizationId,
    ownerId: owner.id,
  });
  const canonical = "accounts/fireworks/models/glm-5p3-flash";
  const model = await ModelModel.create({
    externalId: `vllm/${canonical}`,
    provider: "vllm",
    modelId: canonical,
    inputModalities: ["text"],
    outputModalities: ["text"],
  });
  if (control === "budget")
    await LimitModel.create({
      entityType: "organization",
      entityId: agent.organizationId,
      limitType: "token_cost",
      limitValue: 1,
      model: [canonical],
    });
  if (control === "access") {
    const key = {
      organizationId: agent.organizationId,
      resource: "llmModel" as const,
      scope: model.id,
    };
    const current = await ResourcePermissionPolicyModel.find(key);
    await ResourcePermissionPolicyModel.replace({
      ...key,
      revision: current?.revision ?? 0,
      grants: [],
    });
  }
  modelsDevClient.clearFetchCache();
  let calls = 0;
  server.use(
    http.get("https://models.dev/api.json", () => HttpResponse.json({})),
    http.post(`${baseUrl}/chat/completions`, () => {
      calls++;
      return HttpResponse.json({
        id: "fixture",
        object: "chat.completion",
        created: 1,
        model: canonical,
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "Fixture answer" },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
      });
    }),
  );
  const app = createFastifyInstance();
  await app.register(vllmProxyRoutes);
  try {
    for (const alias of [
      "auto",
      "firerouter/auto",
      "accounts/fireworks/routers/auto",
    ]) {
      const response = await app.inject({
        method: "POST",
        url: `/v1/vllm/${agent.id}/chat/completions`,
        headers: {
          authorization: "Bearer synthetic-test-key",
          "x-archestra-virtual-key": token,
        },
        payload: {
          model: alias,
          messages: [{ role: "user", content: "Fixture request" }],
        },
      });
      expect(response.statusCode, response.body).toBe(
        control === "none" ? 200 : 400,
      );
      if (control === "none") {
        const logged = await InteractionModel.findAllPaginated({
          limit: 1,
          offset: 0,
        });
        expect(Number(logged.data[0].cost)).toBeGreaterThan(0);
      }
    }
    expect(calls).toBe(control === "none" ? 3 : 0);
  } finally {
    await app.close();
    modelsDevClient.clearFetchCache();
  }
});

test.for(
  (["vllm", "openai"] as const).flatMap((provider) =>
    [false, true].flatMap((stream) =>
      [false, true].map((hideAlias) => ({ provider, stream, hideAlias })),
    ),
  ),
)("hidden Fireworks identity blocks both spellings ($provider, stream=$stream, hideAlias=$hideAlias)", async ({
  provider,
  stream,
  hideAlias,
}, { makeAgent, makeUser, makeMember }) => {
  const baseUrl = "https://api.fireworks.ai/inference/v1";
  const canonical = "accounts/fireworks/models/availability-test";
  const shorthand = "availability-test";
  config.llm.vllm.enabled = true;
  config.llm[provider].baseUrl = baseUrl;
  const agent = await makeAgent({ agentType: "llm_proxy" });
  const owner = await makeUser();
  await makeMember(owner.id, agent.organizationId, { role: "admin" });
  const token = await makePassthroughCredential({
    organizationId: agent.organizationId,
    ownerId: owner.id,
  });
  const model = await ModelModel.create({
    provider,
    modelId: canonical,
    externalId: `${provider}/${canonical}`,
    inputModalities: ["text"],
    outputModalities: ["text"],
    ignored: !hideAlias,
  });
  const alias = await ModelModel.create({
    provider,
    modelId: shorthand,
    externalId: `${provider}/${shorthand}`,
    inputModalities: ["text"],
    outputModalities: ["text"],
    ignored: hideAlias,
  });
  let calls = 0;
  server.use(
    http.post(`${baseUrl}/chat/completions`, async ({ request }) => {
      expect(((await request.json()) as { model: string }).model).toBe(
        canonical,
      );
      calls++;
      return HttpResponse.json({
        id: "synthetic",
        object: "chat.completion",
        created: 1,
        model: canonical,
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "Synthetic answer" },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });
    }),
  );
  const app = createFastifyInstance();
  await app.register(provider === "vllm" ? vllmProxyRoutes : openaiProxyRoutes);
  const ask = (model: string, stream: boolean) =>
    app.inject({
      method: "POST",
      url: `/v1/${provider}/${agent.id}/chat/completions`,
      headers: {
        authorization: "Bearer synthetic-test-key",
        "x-archestra-virtual-key": token,
      },
      payload: {
        model,
        stream,
        messages: [{ role: "user", content: "Synthetic request" }],
      },
    });
  try {
    for (const name of [canonical, shorthand]) {
      const response = await ask(name, stream);
      expect(response.statusCode, response.body).toBe(403);
      expect(response.json().error.internal_code).toBe("model_hidden");
    }
    expect(calls).toBe(0);
    await ModelModel.update((hideAlias ? alias : model).id, { ignored: false });
    for (const name of [canonical, shorthand]) {
      const response = await ask(name, false);
      expect(response.statusCode, response.body).toBe(200);
    }
    expect(calls).toBe(2);
  } finally {
    await app.close();
  }
});
