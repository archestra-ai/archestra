import { eq } from "drizzle-orm";
import { HttpResponse, http } from "msw";
import { modelsDevClient } from "@/clients/models-dev-client";
import config from "@/config";
import db, { schema } from "@/database";
import { createFastifyInstance } from "@/fastify-instance";
import {
  LlmProviderApiKeyModelLinkModel,
  ModelModel,
  ModelPoolModel,
  VirtualApiKeyModel,
} from "@/models";
import LimitModel from "@/models/limit";
import LlmThroughputModel from "@/models/llm-throughput";
import ResourcePermissionPolicyModel from "@/models/resource-permission-policy";
import { registerLlmProxyPlugin } from "@/proxy/plugins/registry";
import { accessGrants, expect, test } from "@/test";
import { setupTestCacheManager } from "@/test/cache-manager";
import { makePassthroughCredential } from "@/test/llm-proxy-credentials";
import { useMswServer } from "@/test/msw";
import geminiProxyRoutes from "./routes/gemini";
import modelRouterRoutes from "./routes/model-router";
import openAiProxyRoutes from "./routes/openai";
import vllmProxyRoutes from "./routes/vllm";

// biome-ignore lint/correctness/useHookAtTopLevel: per-test HTTP boundary
const server = useMswServer();
setupTestCacheManager();

const availabilityTest = test.extend<{
  gateway: {
    ask: (options?: {
      model?: string;
      route?: string;
      stream?: boolean;
      caller?: "org" | "admin" | "member";
    }) => Promise<{ statusCode: number; body: string }>;
    setHidden: (hidden: boolean) => Promise<unknown>;
    hits: Array<{ model: string; authorization: string | null }>;
    agentId: string;
    virtualKeyId: string;
    pool: (fallback?: boolean) => Promise<void>;
    onRequest: (hook: (model: string) => Promise<Response | undefined>) => void;
    restrict: () => Promise<void>;
  };
}>({
  gateway: async (
    {
      makeOrganization,
      makeAgent,
      makeSecret,
      makeLlmProviderApiKey,
      makeUser,
      makeMember,
    },
    use,
  ) => {
    const org = await makeOrganization();
    const agent = await makeAgent({
      organizationId: org.id,
      agentType: "llm_proxy",
    });
    const key = await makeLlmProviderApiKey(
      org.id,
      (await makeSecret({ secret: { apiKey: "synthetic-provider-key" } })).id,
      { provider: "openai", baseUrl: "http://availability.example.test/v1" },
    );
    const virtual = await VirtualApiKeyModel.create({
      organizationId: org.id,
      name: "Availability client",
      ...accessGrants("org"),
      providerApiKeys: [{ provider: "openai", providerApiKeyId: key.id }],
    });
    const model = await ModelModel.create({
      provider: "openai",
      modelId: "availability-model",
      externalId: "openai/availability-model",
      inputModalities: ["text"],
      outputModalities: ["text"],
    });
    await LlmProviderApiKeyModelLinkModel.linkModelsToApiKey(key.id, [
      model.id,
    ]);
    const tokens: Record<string, string> = { org: virtual.value };
    for (const role of ["admin", "member"] as const) {
      const owner = await makeUser();
      await makeMember(owner.id, org.id, { role });
      const personal = await VirtualApiKeyModel.create({
        organizationId: org.id,
        name: role,
        scope: "personal",
        authorId: owner.id,
        providerApiKeys: [{ provider: "openai", providerApiKeyId: key.id }],
      });
      tokens[role] = personal.value;
    }
    const hits: Array<{ model: string; authorization: string | null }> = [];
    let beforeResponse:
      | ((model: string) => Promise<Response | undefined>)
      | undefined;
    server.use(
      http.post(
        "http://availability.example.test/v1/chat/completions",
        async ({ request }) => {
          const body = (await request.json()) as {
            model: string;
            stream?: boolean;
          };
          hits.push({
            model: body.model,
            authorization: request.headers.get("authorization"),
          });
          const replacement = await beforeResponse?.(body.model);
          if (replacement) return replacement;
          const common = {
            id: "synthetic-completion",
            object: "chat.completion",
            created: 1,
            model: body.model,
          };
          if (body.stream)
            return new HttpResponse(
              `data: ${JSON.stringify({ ...common, object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: "Hello" }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ ...common, object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 } })}\n\ndata: [DONE]\n\n`,
              { headers: { "content-type": "text/event-stream" } },
            );
          return HttpResponse.json({
            ...common,
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: "Hello" },
                finish_reason: "stop",
              },
            ],
            usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
          });
        },
      ),
    );
    const app = createFastifyInstance();
    await app.register(openAiProxyRoutes);
    await app.register(modelRouterRoutes);
    try {
      await use({
        agentId: agent.id,
        virtualKeyId: virtual.virtualKey.id,
        onRequest: (hook) => {
          beforeResponse = hook;
        },
        hits,
        setHidden: (ignored) => ModelModel.update(model.id, { ignored }),
        ask: ({
          model = "availability-model",
          route = "openai",
          stream = false,
          caller = "org",
        } = {}) =>
          app.inject({
            method: "POST",
            url: `/v1/${route}/${agent.id}/chat/completions`,
            headers: { authorization: `Bearer ${tokens[caller]}` },
            payload: {
              model,
              stream,
              messages: [{ role: "user", content: "Hello" }],
            },
          }),
        restrict: async () => {
          const key = {
            organizationId: org.id,
            resource: "llmModel" as const,
            scope: model.id,
          };
          const policy = await ResourcePermissionPolicyModel.find(key);
          await ResourcePermissionPolicyModel.replace({
            ...key,
            revision: policy?.revision ?? 0,
            grants: [],
          });
        },
        pool: async (fallback) => {
          if (fallback)
            await ModelModel.create({
              provider: "openai",
              modelId: "hidden-fallback",
              externalId: "openai/hidden-fallback",
              inputModalities: ["text"],
              outputModalities: ["text"],
              ignored: true,
            });
          config.llmProxy.modelPoolsEnabled = true;
          const pool = await ModelPoolModel.create({
            organizationId: org.id,
            input: {
              name: "availability-pool",
              members: [
                {
                  providerApiKeyId: key.id,
                  modelId: model.modelId,
                  enabled: true,
                  priority: 0,
                  weight: 1,
                },
                ...(fallback
                  ? [
                      {
                        providerApiKeyId: key.id,
                        modelId: "hidden-fallback",
                        enabled: true,
                        priority: 1,
                        weight: 1,
                      },
                    ]
                  : []),
              ],
            },
          });
          await ModelPoolModel.setPoolsForVirtualApiKey({
            organizationId: org.id,
            virtualApiKeyId: virtual.virtualKey.id,
            poolIds: [pool.id],
          });
        },
      });
    } finally {
      await app.close();
    }
  },
});

availabilityTest.for([false, true])(
  "hide blocks direct execution and unhide restores it (stream=%s)",
  async (stream, { gateway }) => {
    const first = await gateway.ask({ stream });
    expect(first.statusCode, first.body).toBe(200);
    const before = await db
      .select()
      .from(schema.interactionsTable)
      .where(eq(schema.interactionsTable.profileId, gateway.agentId));
    await gateway.setHidden(true);
    const hidden = await gateway.ask({ stream });
    expect(hidden.statusCode, hidden.body).toBe(403);
    expect(JSON.parse(hidden.body).error.internal_code).toBe("model_hidden");
    expect(gateway.hits).toHaveLength(1);
    const rows = await db
      .select()
      .from(schema.interactionsTable)
      .where(eq(schema.interactionsTable.profileId, gateway.agentId));
    // Refusing a call must not add usage or billed cost, whether or not the
    // deployment retains an audit row for the refusal.
    const totals = (items: typeof rows) =>
      items.reduce(
        (sum, row) => ({
          input: sum.input + (row.inputTokens ?? 0),
          output: sum.output + (row.outputTokens ?? 0),
          cost: sum.cost + Number(row.cost ?? 0),
        }),
        { input: 0, output: 0, cost: 0 },
      );
    expect(totals(rows)).toEqual(totals(before));
    await gateway.setHidden(false);
    const restored = await gateway.ask({ stream });
    expect(restored.statusCode, restored.body).toBe(200);
    expect(gateway.hits).toHaveLength(2);
    expect(
      gateway.hits.every(
        (hit) =>
          hit.model === "availability-model" &&
          hit.authorization === "Bearer synthetic-provider-key",
      ),
    ).toBe(true);
  },
);

availabilityTest(
  "a saved pool cannot execute its hidden member",
  async ({ gateway }) => {
    await gateway.pool();
    await gateway.setHidden(true);
    const hidden = await gateway.ask({
      model: "availability-pool",
      route: "model-router",
    });
    expect(hidden.statusCode, hidden.body).toBe(403);
    expect(JSON.parse(hidden.body).error.internal_code).toBe("model_hidden");
    expect(gateway.hits).toHaveLength(0);
    await gateway.setHidden(false);
    const restored = await gateway.ask({
      model: "availability-pool",
      route: "model-router",
    });
    expect(restored.statusCode, restored.body).toBe(200);
    expect(gateway.hits).toHaveLength(1);
  },
);

availabilityTest(
  "unknown custom models remain callable",
  async ({ gateway }) => {
    await gateway.setHidden(true);
    const response = await gateway.ask({
      model: "custom-model-not-in-catalog",
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(gateway.hits[0].model).toBe("custom-model-not-in-catalog");
  },
);

availabilityTest.for(["admin", "member"] as const)(
  "hidden blocks personal %s keys despite use grants",
  async (caller, { gateway }) => {
    await gateway.setHidden(true);
    const response = await gateway.ask({ caller });
    expect(response.statusCode, response.body).toBe(403);
    expect(JSON.parse(response.body).error.internal_code).toBe("model_hidden");
    expect(gateway.hits).toHaveLength(0);
    await gateway.setHidden(false);
    const restored = await gateway.ask({ caller });
    expect(restored.statusCode, restored.body).toBe(200);
    if (caller === "member") {
      await gateway.restrict();
      const restricted = await gateway.ask({ caller });
      expect(restricted.statusCode, restricted.body).toBe(403);
      expect(gateway.hits).toHaveLength(1);
    }
  },
);

availabilityTest.for([false, true])(
  "hiding preserves an already-started call but blocks the next (stream=%s)",
  async (stream, { gateway }) => {
    let release!: () => void;
    let reached!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      reached = resolve;
    });
    gateway.onRequest(async () => {
      if (!stream) {
        reached();
        await waiting;
        return undefined;
      }
      const encoder = new TextEncoder();
      const event = (delta: Record<string, string>, finish: string | null) =>
        `data: ${JSON.stringify({ id: "running-stream", object: "chat.completion.chunk", created: 1, model: "availability-model", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
      return new HttpResponse(
        new ReadableStream({
          async start(controller) {
            controller.enqueue(
              encoder.encode(
                event({ role: "assistant", content: "Started" }, null),
              ),
            );
            reached();
            await waiting;
            controller.enqueue(
              encoder.encode(
                `${event({ content: " finished" }, "stop")}data: [DONE]\n\n`,
              ),
            );
            controller.close();
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
    });
    const ongoing = gateway.ask({ stream });
    await started;
    await gateway.setHidden(true);
    release();
    const completed = await ongoing;
    expect(completed.statusCode, completed.body).toBe(200);
    if (stream) {
      expect(completed.body).toContain("Started");
      expect(completed.body).toContain(" finished");
      expect(completed.body).toContain("[DONE]");
    }
    const next = await gateway.ask();
    expect(next.statusCode, next.body).toBe(403);
    expect(gateway.hits).toHaveLength(1);
  },
);

availabilityTest(
  "failover cannot start a hidden fallback member",
  async ({ gateway }) => {
    await gateway.pool(true);
    gateway.onRequest(async () =>
      HttpResponse.json(
        { error: { message: "Synthetic outage" } },
        { status: 503 },
      ),
    );
    const response = await gateway.ask({
      model: "availability-pool",
      route: "model-router",
    });
    expect(response.statusCode, response.body).toBe(503);
    expect(response.body).toContain("Synthetic outage");
    const records = await db.select().from(schema.interactionsTable);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      model: "availability-model",
      attemptOutcome: "failed",
    });
    expect(gateway.hits.map((hit) => hit.model)).toEqual([
      "availability-model",
    ]);
  },
);

availabilityTest.for([false, true])(
  "skips hidden pool choices without charges or cooldown (stream=%s)",
  async (stream, { gateway }) => {
    await gateway.pool(true);
    await gateway.setHidden(true);
    const fallback = await ModelModel.findByProviderAndModelId(
      "openai",
      "hidden-fallback",
    );
    if (!fallback) throw new Error("Missing fallback fixture");
    const requestCap = await LimitModel.create({
      entityType: "virtual_key",
      entityId: gateway.virtualKeyId,
      limitType: "requests",
      cleanupInterval: "calendar_day",
      limitValue: 2,
    });
    const ask = () =>
      gateway.ask({
        model: "availability-pool",
        route: "model-router",
        stream,
      });
    // Every member is hidden: no upstream attempt and no request allowance spent.
    expect((await ask()).statusCode).toBe(403);
    expect(
      (await LlmThroughputModel.usage([requestCap])).get(requestCap.id)
        ?.currentUsage ?? 0,
    ).toBe(0);
    expect(gateway.hits).toHaveLength(0);
    await ModelModel.update(fallback.id, { ignored: false });
    expect((await ask()).statusCode).toBe(200);
    expect(gateway.hits.map((hit) => hit.model)).toEqual(["hidden-fallback"]);
    expect(
      (await LlmThroughputModel.usage([requestCap])).get(requestCap.id)
        ?.currentUsage,
    ).toBe(1);
    // Showing the primary restores its priority immediately, without a cooldown.
    await gateway.setHidden(false);
    expect((await ask()).statusCode).toBe(200);
    expect(gateway.hits.map((hit) => hit.model)).toEqual([
      "hidden-fallback",
      "availability-model",
    ]);
    expect((await ask()).statusCode).toBe(429);
    expect(gateway.hits).toHaveLength(2);
  },
);

// The plugin lifecycle runs after admission and before dispatch. A hide during
// this interval must be observed by the final availability check.
availabilityTest.for([false, true])(
  "rechecks availability after admission (stream=%s)",
  async (stream, { gateway }) => {
    const unregister = registerLlmProxyPlugin({
      id: `availability-${crypto.randomUUID()}`,
      async onBeforeModel() {
        await gateway.setHidden(true);
      },
    });
    try {
      const response = await gateway.ask({ stream });
      expect(response.statusCode, response.body).toBe(403);
      expect(JSON.parse(response.body).error.internal_code).toBe(
        "model_hidden",
      );
      expect(gateway.hits).toHaveLength(0);
    } finally {
      unregister();
    }
  },
);

test.for(
  (["vllm", "openai"] as const).flatMap((provider) =>
    [false, true].map((hideAlias) => ({ provider, hideAlias })),
  ),
)("hidden Fireworks identity blocks both spellings ($provider, hideAlias=$hideAlias)", async ({
  provider,
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
  await app.register(provider === "vllm" ? vllmProxyRoutes : openAiProxyRoutes);
  const ask = (model: string) =>
    app.inject({
      method: "POST",
      url: `/v1/${provider}/${agent.id}/chat/completions`,
      headers: {
        authorization: "Bearer synthetic-test-key",
        "x-archestra-virtual-key": token,
      },
      payload: {
        model,
        messages: [{ role: "user", content: "Synthetic request" }],
      },
    });
  try {
    for (const name of [canonical, shorthand]) {
      const response = await ask(name);
      expect(response.statusCode, response.body).toBe(403);
      expect(response.json().error.internal_code).toBe("model_hidden");
    }
    expect(calls).toBe(0);
    await ModelModel.update((hideAlias ? alias : model).id, { ignored: false });
    for (const name of [canonical, shorthand]) {
      const response = await ask(name);
      expect(response.statusCode, response.body).toBe(200);
    }
    expect(calls).toBe(2);
  } finally {
    await app.close();
  }
});

test.for([
  false,
  true,
])("a hidden canonical pool member releases its unsent allowance (stream=%s)", async (stream, {
  makeOrganization,
  makeAgent,
  makeSecret,
  makeLlmProviderApiKey,
}) => {
  config.llmProxy.modelPoolsEnabled = true;
  const canonical = "accounts/fireworks/models/glm-5p3-flash";
  const fireworks = "https://api.fireworks.ai/inference/v1";
  config.llm.vllm.enabled = true;
  config.llm.vllm.baseUrl = fireworks;
  const org = await makeOrganization();
  const agent = await makeAgent({
    organizationId: org.id,
    agentType: "llm_proxy",
  });
  const key = await makeLlmProviderApiKey(
    org.id,
    (await makeSecret({ secret: { apiKey: "synthetic-unsent-pool" } })).id,
    { provider: "vllm", baseUrl: fireworks },
  );
  const virtual = await VirtualApiKeyModel.create({
    organizationId: org.id,
    name: "Unsent pool client",
    ...accessGrants("org"),
    providerApiKeys: [{ provider: "vllm", providerApiKeyId: key.id }],
  });
  const pool = await ModelPoolModel.create({
    organizationId: org.id,
    input: {
      name: "guarded-fireworks-pool",
      members: [
        {
          providerApiKeyId: key.id,
          modelId: "glm-5p3-flash",
          priority: 1,
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
  const requestCap = await LimitModel.create({
    entityType: "virtual_key",
    entityId: virtual.virtualKey.id,
    limitType: "requests",
    cleanupInterval: "calendar_day",
    limitValue: 1,
  });
  await LimitModel.create({
    entityType: "organization",
    entityId: org.id,
    limitType: "token_cost",
    limitValue: 1,
    model: [canonical],
  });
  await ModelModel.create({
    externalId: `vllm/${canonical}`,
    provider: "vllm",
    modelId: canonical,
    ignored: true,
    inputModalities: ["text"],
    outputModalities: ["text"],
  });
  modelsDevClient.clearFetchCache();
  let dispatched = 0;
  server.use(
    http.get("https://models.dev/api.json", () =>
      HttpResponse.json({
        "fireworks-ai": {
          id: "fireworks-ai",
          name: "Fireworks",
          models: {
            [canonical]: {
              id: canonical,
              name: "GLM fixture",
              cost: { input: 2, output: 8 },
            },
          },
        },
      }),
    ),
    http.post(`${fireworks}/chat/completions`, () => {
      dispatched++;
      return HttpResponse.json(
        { error: { message: "Unexpected dispatch" } },
        { status: 500 },
      );
    }),
  );
  const app = createFastifyInstance();
  await app.register(vllmProxyRoutes);
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await app.inject({
        method: "POST",
        url: `/v1/vllm/${agent.id}/chat/completions`,
        headers: { authorization: `Bearer ${virtual.value}` },
        payload: {
          model: "guarded-fireworks-pool",
          stream,
          messages: [{ role: "user", content: "Fixture request" }],
        },
      });
      // A leaked reservation would turn the second rejection into quota 429.
      expect(response.statusCode, response.body).toBe(403);
      expect(response.json().error.internal_code).toBe("model_hidden");
      const usage = await LlmThroughputModel.usage([requestCap]);
      expect(usage.get(requestCap.id)?.currentUsage ?? 0).toBe(0);
    }
    expect(dispatched).toBe(0);
  } finally {
    await app.close();
    modelsDevClient.clearFetchCache();
  }
});

test.for([
  false,
  true,
])("Gemini embedding aliases cannot bypass a hidden catalog model (stored prefix=%s)", async (prefixed, {
  makeAgent,
  makeUser,
  makeMember,
}) => {
  const originalBaseUrl = config.llm.gemini.baseUrl;
  config.llm.gemini.baseUrl = "https://gemini-availability.example.test";
  const agent = await makeAgent({ agentType: "llm_proxy" });
  const owner = await makeUser();
  await makeMember(owner.id, agent.organizationId, { role: "admin" });
  const token = await makePassthroughCredential({
    organizationId: agent.organizationId,
    ownerId: owner.id,
  });
  const bare = "gemini-embedding-001";
  const stored = prefixed ? `models/${bare}` : bare;
  const requested = prefixed ? bare : `models/${bare}`;
  const model = await ModelModel.create({
    provider: "gemini",
    modelId: stored,
    externalId: `gemini/${stored}`,
    inputModalities: ["text"],
    outputModalities: ["text"],
    ignored: true,
  });
  let calls = 0;
  server.use(
    http.post(
      "https://gemini-availability.example.test/v1beta/models/:operation",
      () => {
        calls++;
        return HttpResponse.json({
          embedding: { values: [0.1, 0.2] },
          embeddings: [{ values: [0.1, 0.2] }],
        });
      },
    ),
  );
  const app = createFastifyInstance();
  await app.register(geminiProxyRoutes);
  const ask = () =>
    app.inject({
      method: "POST",
      url: `/v1/gemini/${agent.id}/embeddings`,
      headers: {
        authorization: "Bearer synthetic-provider-key",
        "x-archestra-virtual-key": token,
      },
      payload: { model: requested, input: "fixture" },
    });
  try {
    const hidden = await ask();
    expect(hidden.statusCode, hidden.body).toBe(403);
    expect(hidden.json().error.internal_code).toBe("model_hidden");
    expect(calls).toBe(0);
    await ModelModel.update(model.id, { ignored: false });
    const shown = await ask();
    expect(shown.statusCode, shown.body).toBe(200);
    expect(calls).toBe(1);
  } finally {
    config.llm.gemini.baseUrl = originalBaseUrl;
    await app.close();
  }
});
