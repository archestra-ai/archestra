import { eq } from "drizzle-orm";
import { HttpResponse, http } from "msw";
import config from "@/config";
import db, { schema } from "@/database";
import { createFastifyInstance } from "@/fastify-instance";
import {
  LlmProviderApiKeyModelLinkModel,
  ModelModel,
  ModelPoolModel,
  VirtualApiKeyModel,
} from "@/models";
import ResourcePermissionPolicyModel from "@/models/resource-permission-policy";
import { registerLlmProxyPlugin } from "@/proxy/plugins/registry";
import { accessGrants, expect, test } from "@/test";
import { setupTestCacheManager } from "@/test/cache-manager";
import { useMswServer } from "@/test/msw";
import modelRouterRoutes from "./model-router";
import openAiProxyRoutes from "./openai";

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
    pool: (fallback?: boolean) => Promise<void>;
    onRequest: (hook: (model: string) => Promise<Response | undefined>) => void;
    restrict: () => Promise<void>;
    list: () => Promise<string>;
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
        list: async () =>
          (
            await app.inject({
              method: "GET",
              url: `/v1/model-router/${agent.id}/models`,
              headers: { authorization: `Bearer ${virtual.value}` },
            })
          ).body,
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
  },
);

availabilityTest(
  "catalog and router follow hide/unhide and existing grants still apply",
  async ({ gateway }) => {
    expect(await gateway.list()).toContain("openai:availability-model");
    await gateway.setHidden(true);
    expect(await gateway.list()).not.toContain("openai:availability-model");
    const hidden = await gateway.ask({
      route: "model-router",
      model: "openai:availability-model",
    });
    expect(hidden.statusCode, hidden.body).toBeGreaterThanOrEqual(400);
    expect(gateway.hits).toHaveLength(0);
    await gateway.setHidden(false);
    expect(await gateway.list()).toContain("openai:availability-model");
    const restored = await gateway.ask({
      route: "model-router",
      model: "openai:availability-model",
    });
    expect(restored.statusCode, restored.body).toBe(200);
    await gateway.restrict();
    const restricted = await gateway.ask({ caller: "member" });
    expect(restricted.statusCode, restricted.body).toBe(403);
    expect(gateway.hits).toHaveLength(1);
  },
);

availabilityTest(
  "hiding does not cancel an already-started call, but blocks the next",
  async ({ gateway }) => {
    let release!: () => void;
    let reached!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      reached = resolve;
    });
    gateway.onRequest(async () => {
      reached();
      await waiting;
      return undefined;
    });
    const ongoing = gateway.ask();
    await started;
    await gateway.setHidden(true);
    release();
    expect((await ongoing).statusCode).toBe(200);
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
    expect(response.statusCode, response.body).toBe(403);
    expect(JSON.parse(response.body).error.internal_code).toBe("model_hidden");
    expect(gateway.hits.map((hit) => hit.model)).toEqual([
      "availability-model",
    ]);
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
