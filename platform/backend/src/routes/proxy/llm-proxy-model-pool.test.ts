/**
 * Model pool failover on the LLM proxy, end to end through the OpenAI route.
 * The provider is stubbed at the adapter-client boundary: the pool's first
 * member is rate limited, the second answers.
 */

import {
  CHAT_API_KEY_ID_HEADER,
  MODEL_POOL_ID_HEADER,
} from "@archestra/shared";
import Fastify, { type FastifyInstance } from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import type OpenAI from "openai";
import { vi } from "vitest";
import { internalCallHeader } from "@/clients/internal-call";
import config from "@/config";
import db, { schema } from "@/database";
import { ModelModel, ModelPoolModel, VirtualApiKeyModel } from "@/models";
import LimitModel from "@/models/limit";
import LlmThroughputModel from "@/models/llm-throughput";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import { setupTestCacheManager } from "@/test/cache-manager";
import { createOpenAiTestClient } from "@/test/llm-provider-stubs";
import type { Agent } from "@/types";
import { openaiAdapterFactory } from "./adapters";
import { virtualKeyRateLimiter } from "./llm-proxy-auth";
import openAiProxyRoutes from "./routes/openai";

// Model pools are a beta feature; these tests run with it on.
beforeEach(() => {
  config.llmProxy.modelPoolsEnabled = true;
});

setupTestCacheManager();

describe("Model pools - LLM Proxy", () => {
  let app: FastifyInstance;
  let proxy: Agent;

  beforeEach(async ({ makeAgent }) => {
    app = Fastify().withTypeProvider<ZodTypeProvider>();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);

    vi.spyOn(openaiAdapterFactory, "createClient").mockImplementation(
      (apiKey) => {
        if (apiKey === "sk-silent") {
          // Never answers: only the pool's timeout moves the request on.
          const silent = () => new Promise(() => {});
          return { chat: { completions: { create: silent } } } as never;
        }
        if (apiKey !== "sk-limited") {
          return createOpenAiTestClient({}) as never;
        }
        const rateLimited = () => {
          throw Object.assign(new Error("Rate limit reached"), {
            status: 429,
            headers: new Headers({ "retry-after": "20" }),
          });
        };
        return { chat: { completions: { create: rateLimited } } } as never;
      },
    );
    vi.spyOn(virtualKeyRateLimiter, "check").mockResolvedValue(undefined);

    proxy = await makeAgent({ name: "pool-proxy", agentType: "llm_proxy" });
    await app.register(openAiProxyRoutes);
    await ModelModel.upsert({
      externalId: "openai/gpt-4o-mini",
      provider: "openai",
      modelId: "gpt-4o-mini",
      inputModalities: null,
      outputModalities: null,
      customPricePerMillionInput: "0.15",
      customPricePerMillionOutput: "0.60",
      lastSyncedAt: new Date(),
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await app.close();
  });

  for (const stream of [false, true]) {
    for (const { cappedModel, minute } of [
      "model-a",
      "model-b",
      "pool-alias",
    ].flatMap((cappedModel) =>
      [false, true].map((minute) => ({ cappedModel, minute })),
    )) {
      test(`checks the actual pool attempt against ${cappedModel} without budget-based failover (stream: ${stream}, minute: ${minute})`, async ({
        makeSecret,
        makeLlmProviderApiKey,
      }) => {
        const key = await makeLlmProviderApiKey(
          proxy.organizationId,
          (await makeSecret({ secret: { apiKey: "sk-pool" } })).id,
          { provider: "openai" },
        );
        const { virtualKey, value: token } = await VirtualApiKeyModel.create({
          organizationId: proxy.organizationId,
          name: "budget-pool-key",
          providerApiKeys: [{ provider: "openai", providerApiKeyId: key.id }],
        });
        const modelIds = ["model-a", "model-b", "model-c"];
        for (const modelId of modelIds) {
          await ModelModel.create({
            externalId: `openai/${modelId}`,
            provider: "openai",
            modelId,
            inputModalities: ["text"],
            outputModalities: ["text"],
            customPricePerMillionInput: "1",
            customPricePerMillionOutput: "1",
          });
        }
        await ModelPoolModel.create({
          organizationId: proxy.organizationId,
          input: {
            name: "pool-alias",
            members: modelIds.map((modelId, index) => ({
              providerApiKeyId: key.id,
              modelId,
              priority: index + 1,
              weight: 1,
              enabled: true,
            })),
          },
        });
        await LimitModel.create({
          entityType: "virtual_key",
          entityId: virtualKey.id,
          limitType: "token_cost",
          limitValue: minute ? 1 : 0,
          model: [cappedModel],
          ...(minute ? { cleanupInterval: "minute" as const } : {}),
          lastCleanup: new Date(),
        });
        if (minute) {
          const scope = {
            entities: [
              { entityType: "virtual_key" as const, entityId: virtualKey.id },
            ],
            model: cappedModel,
          };
          const admitted = await LlmThroughputModel.admit(scope);
          if (!("reservation" in admitted) || !admitted.reservation)
            throw new Error("Expected spend receipt");
          await LlmThroughputModel.reconcile({
            reservation: admitted.reservation,
            tokens: 0,
            spend: 2,
            billingMode: "metered",
          });
          expect(await LlmThroughputModel.admit(scope)).toHaveProperty(
            "denied",
          );
        }
        const rpm = await LimitModel.create({
          entityType: "organization",
          entityId: proxy.organizationId,
          limitType: "requests_per_minute",
          limitValue: 1,
        });
        const dispatched: string[] = [];
        vi.mocked(openaiAdapterFactory.createClient).mockImplementation(() => {
          const client = createOpenAiTestClient();
          return {
            chat: {
              completions: {
                create: async (
                  request: OpenAI.Chat.Completions.ChatCompletionCreateParams,
                ) => {
                  dispatched.push(request.model);
                  if (request.model === "model-a")
                    throw Object.assign(new Error("Rate limited"), {
                      status: 429,
                    });
                  return client.chat.completions.create(request);
                },
              },
            },
          } as never;
        });

        const response = await app.inject({
          method: "POST",
          url: `/v1/openai/${proxy.id}/chat/completions`,
          headers: { authorization: `Bearer ${token}` },
          payload: {
            model: "pool-alias",
            stream,
            messages: [{ role: "user", content: "Hello" }],
          },
        });

        expect(response.statusCode, response.body).toBe(
          cappedModel === "pool-alias" ? 200 : 402,
        );
        expect(dispatched).toEqual(
          cappedModel === "model-a"
            ? []
            : cappedModel === "model-b"
              ? ["model-a"]
              : ["model-a", "model-b"],
        );
        if (cappedModel !== "pool-alias") {
          expect(response.json().error).toMatchObject({
            type: "usage_limit_exceeded",
            code: "token_cost_limit_exceeded",
          });
          if (minute) {
            expect(Number(response.headers["retry-after"])).toBeGreaterThan(0);
            expect(response.json().error.quota).toMatchObject({
              entityType: "virtual_key",
              limitType: "token_cost",
              oversized: false,
              retryAfter: Number(response.headers["retry-after"]),
            });
          }
          expect(
            (await LlmThroughputModel.usage([rpm])).get(rpm.id)?.currentUsage,
          ).toBeCloseTo(cappedModel === "model-a" ? 0 : 1, 2);
          const rows = await db.select().from(schema.interactionsTable);
          expect(
            rows.map(({ model, attempt, attemptOutcome, failureReason }) => ({
              model,
              attempt,
              attemptOutcome,
              failureReason,
            })),
          ).toEqual(
            cappedModel === "model-a"
              ? []
              : [
                  {
                    model: "model-a",
                    attempt: 1,
                    attemptOutcome: "failed_over",
                    failureReason: "rate_limited (429)",
                  },
                ],
          );
          const unrelated = await app.inject({
            method: "POST",
            url: `/v1/openai/${proxy.id}/chat/completions`,
            headers: { authorization: `Bearer ${token}` },
            payload: {
              model: "model-c",
              stream,
              messages: [{ role: "user", content: "Hello" }],
            },
          });
          expect(unrelated.statusCode, unrelated.body).toBe(
            cappedModel === "model-a" ? 200 : 429,
          );
        }
      });
    }

    test(`answers from the next member when the pinned one is rate limited (stream: ${stream})`, async ({
      makeSecret,
      makeLlmProviderApiKey,
    }) => {
      const limited = await makeLlmProviderApiKey(
        proxy.organizationId,
        (await makeSecret({ secret: { apiKey: "sk-limited" } })).id,
        { provider: "openai" },
      );
      const healthy = await makeLlmProviderApiKey(
        proxy.organizationId,
        (await makeSecret({ secret: { apiKey: "sk-healthy" } })).id,
        { provider: "openai" },
      );
      const { value: virtualKey, virtualKey: virtualKeyRow } =
        await VirtualApiKeyModel.create({
          name: "pinned-to-limited",
          providerApiKeys: [
            { provider: "openai", providerApiKeyId: limited.id },
          ],
        });
      const pool = await ModelPoolModel.create({
        organizationId: proxy.organizationId,
        input: {
          name: "gpt-4o-mini",
          members: [
            {
              providerApiKeyId: limited.id,
              modelId: "gpt-4o-mini",
              priority: 1,
              weight: 1,
              enabled: true,
            },
            {
              providerApiKeyId: healthy.id,
              modelId: "gpt-4o-mini",
              priority: 2,
              weight: 1,
              enabled: true,
            },
          ],
        },
      });
      await ModelPoolModel.setPoolsForVirtualApiKey({
        organizationId: proxy.organizationId,
        virtualApiKeyId: virtualKeyRow.id,
        poolIds: [pool.id],
      });

      const response = await app.inject({
        method: "POST",
        url: `/v1/openai/${proxy.id}/chat/completions`,
        remoteAddress: "203.0.113.5",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${virtualKey}`,
        },
        payload: {
          model: "gpt-4o-mini",
          messages: [{ role: "user", content: "hello" }],
          stream,
        },
      });

      expect(response.statusCode, response.body).toBe(200);
      expect(response.headers["x-archestra-pool"]).toBe("gpt-4o-mini");
      expect(response.headers["x-archestra-attempts"]).toBe("2");
      expect(response.headers["x-archestra-provider-key"]).toBe(healthy.id);

      const rows = await db
        .select()
        .from(schema.interactionsTable)
        .orderBy(schema.interactionsTable.attempt);
      expect(
        rows.map((row) => ({
          providerApiKeyId: row.providerApiKeyId,
          modelPoolId: row.modelPoolId,
          attempt: row.attempt,
          attemptOutcome: row.attemptOutcome,
          failureReason: row.failureReason,
          cost: row.cost === null ? null : Number(row.cost),
        })),
      ).toEqual([
        {
          providerApiKeyId: limited.id,
          modelPoolId: pool.id,
          attempt: 1,
          attemptOutcome: "failed_over",
          failureReason: "rate_limited (429)",
          cost: 0,
        },
        {
          providerApiKeyId: healthy.id,
          modelPoolId: pool.id,
          attempt: 2,
          attemptOutcome: "answered",
          failureReason: null,
          cost: expect.any(Number),
        },
      ]);
    });
  }

  for (const stream of [false, true]) {
    test(`moves past a silent member after the pool's own timeout (stream: ${stream})`, async ({
      makeSecret,
      makeLlmProviderApiKey,
    }) => {
      const [silent, healthy] = [
        await makeLlmProviderApiKey(
          proxy.organizationId,
          (await makeSecret({ secret: { apiKey: "sk-silent" } })).id,
          { provider: "openai" },
        ),
        await makeLlmProviderApiKey(
          proxy.organizationId,
          (await makeSecret({ secret: { apiKey: "sk-healthy" } })).id,
          { provider: "openai" },
        ),
      ];
      const { value: virtualKey, virtualKey: virtualKeyRow } =
        await VirtualApiKeyModel.create({
          name: "pinned-to-silent",
          providerApiKeys: [
            { provider: "openai", providerApiKeyId: silent.id },
          ],
        });
      for (const modelId of ["silent-model", "healthy-model"]) {
        await ModelModel.create({
          externalId: `openai/${modelId}`,
          provider: "openai",
          modelId,
          inputModalities: ["text"],
          outputModalities: ["text"],
          customPricePerMillionInput: "1000000",
          customPricePerMillionOutput: "1000000",
        });
      }
      const rpm = await LimitModel.create({
        entityType: "organization",
        entityId: proxy.organizationId,
        limitType: "requests_per_minute",
        limitValue: 1,
      });
      const budgets = [];
      for (const model of [
        null,
        ["silent-model", "healthy-model"],
        ["silent-model"],
        ["healthy-model"],
      ]) {
        budgets.push(
          await LimitModel.create({
            entityType: "organization",
            entityId: proxy.organizationId,
            limitType: "token_cost",
            cleanupInterval: "minute",
            limitValue: 100,
            model,
          }),
        );
      }
      // The defaults (30 s first chunk, 3 min response) would outlast the test.
      const pool = await ModelPoolModel.create({
        organizationId: proxy.organizationId,
        input: {
          name: "gpt-4o-mini",
          streamTimeoutSeconds: 1,
          timeoutSeconds: 1,
          members: [silent, healthy].map((key, index) => ({
            providerApiKeyId: key.id,
            modelId: index === 0 ? "silent-model" : "healthy-model",
            priority: index + 1,
            weight: 1,
            enabled: true,
          })),
        },
      });
      await ModelPoolModel.setPoolsForVirtualApiKey({
        organizationId: proxy.organizationId,
        virtualApiKeyId: virtualKeyRow.id,
        poolIds: [pool.id],
      });

      const response = await app.inject({
        method: "POST",
        url: `/v1/openai/${proxy.id}/chat/completions`,
        remoteAddress: "203.0.113.5",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${virtualKey}`,
        },
        payload: {
          model: "gpt-4o-mini",
          messages: [{ role: "user", content: "hello" }],
          stream,
        },
      });

      expect(response.statusCode, response.body).toBe(200);
      expect(response.headers["x-archestra-provider-key"]).toBe(healthy.id);
      const rows = await db
        .select()
        .from(schema.interactionsTable)
        .orderBy(schema.interactionsTable.attempt);
      expect(rows.map((row) => row.failureReason)).toEqual([
        "timeout (408)",
        null,
      ]);
      const costs = rows.map((row) => Number(row.cost));
      expect(costs.every((cost) => cost > 0)).toBe(true);
      const usage = await LlmThroughputModel.usage([rpm, ...budgets]);
      expect(usage.get(rpm.id)?.currentUsage).toBeCloseTo(1, 1);
      // Leaky minute buckets drain during database writes; both billed attempts
      // must contribute once to the shared/global caps and only to their own model.
      for (const [index, expected] of [
        costs[0] + costs[1],
        costs[0] + costs[1],
        ...costs,
      ].entries()) {
        const actual = usage.get(budgets[index].id)?.currentUsage ?? 0;
        expect(actual).toBeGreaterThan(expected - 5);
        expect(actual).toBeLessThanOrEqual(expected);
      }
    });
  }

  test("logs the last member's failure at cost 0 with its reason", async ({
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    const [first, second] = [
      await makeLlmProviderApiKey(
        proxy.organizationId,
        (await makeSecret({ secret: { apiKey: "sk-limited" } })).id,
        { provider: "openai" },
      ),
      await makeLlmProviderApiKey(
        proxy.organizationId,
        (await makeSecret({ secret: { apiKey: "sk-limited" } })).id,
        { provider: "openai" },
      ),
    ];
    const { value: virtualKey, virtualKey: virtualKeyRow } =
      await VirtualApiKeyModel.create({
        name: "all-limited",
        providerApiKeys: [{ provider: "openai", providerApiKeyId: first.id }],
      });
    const pool = await ModelPoolModel.create({
      organizationId: proxy.organizationId,
      input: {
        name: "gpt-4o-mini",
        members: [first, second].map((key, index) => ({
          providerApiKeyId: key.id,
          modelId: "gpt-4o-mini",
          priority: index + 1,
          weight: 1,
          enabled: true,
        })),
      },
    });
    await ModelPoolModel.setPoolsForVirtualApiKey({
      organizationId: proxy.organizationId,
      virtualApiKeyId: virtualKeyRow.id,
      poolIds: [pool.id],
    });

    const response = await app.inject({
      method: "POST",
      url: `/v1/openai/${proxy.id}/chat/completions`,
      remoteAddress: "203.0.113.5",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${virtualKey}`,
      },
      payload: {
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: "hello" }],
      },
    });

    expect(response.statusCode).toBe(429);
    const rows = await db
      .select()
      .from(schema.interactionsTable)
      .orderBy(schema.interactionsTable.attempt);
    expect(
      rows.map((row) => ({
        providerApiKeyId: row.providerApiKeyId,
        attemptOutcome: row.attemptOutcome,
        failureReason: row.failureReason,
        cost: row.cost === null ? null : Number(row.cost),
      })),
    ).toEqual([
      {
        providerApiKeyId: first.id,
        attemptOutcome: "failed_over",
        failureReason: "rate_limited (429)",
        cost: 0,
      },
      {
        providerApiKeyId: second.id,
        attemptOutcome: "failed",
        failureReason: "rate_limited (429)",
        cost: 0,
      },
    ]);
  });

  test("pools a platform call only when it names the pool", async ({
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    const limited = await makeLlmProviderApiKey(
      proxy.organizationId,
      (await makeSecret({ secret: { apiKey: "sk-limited" } })).id,
      { provider: "openai" },
    );
    const healthy = await makeLlmProviderApiKey(
      proxy.organizationId,
      (await makeSecret({ secret: { apiKey: "sk-healthy" } })).id,
      { provider: "openai" },
    );
    const pool = await ModelPoolModel.create({
      organizationId: proxy.organizationId,
      input: {
        name: "gpt-4o-mini",
        members: [limited.id, healthy.id].map((providerApiKeyId, i) => ({
          providerApiKeyId,
          modelId: "gpt-4o-mini",
          priority: i + 1,
          weight: 1,
          enabled: true,
        })),
      },
    });
    const post = (headers: Record<string, string> = {}) =>
      app.inject({
        method: "POST",
        url: `/v1/openai/${proxy.id}/chat/completions`,
        remoteAddress: "127.0.0.1",
        headers: {
          ...internalCallHeader(),
          "content-type": "application/json",
          authorization: "Bearer sk-limited",
          [CHAT_API_KEY_ID_HEADER]: limited.id,
          ...headers,
        },
        payload: {
          model: "gpt-4o-mini",
          messages: [{ role: "user", content: "hello" }],
        },
      });

    // A chat on a member key and the pool's model runs on that key alone.
    const direct = await post();
    expect(direct.statusCode, direct.body).toBe(429);
    expect(direct.headers["x-archestra-pool"]).toBeUndefined();

    const pooled = await post({ [MODEL_POOL_ID_HEADER]: pool.id });
    expect(pooled.statusCode, pooled.body).toBe(200);
    expect(pooled.headers["x-archestra-pool"]).toBe("gpt-4o-mini");
    expect(pooled.headers["x-archestra-provider-key"]).toBe(healthy.id);
  });

  test("records the provider key on a call no pool handles", async ({
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    const key = await makeLlmProviderApiKey(
      proxy.organizationId,
      (await makeSecret({ secret: { apiKey: "sk-healthy" } })).id,
      { provider: "openai" },
    );
    const { value: virtualKey } = await VirtualApiKeyModel.create({
      name: "plain",
      providerApiKeys: [{ provider: "openai", providerApiKeyId: key.id }],
    });

    const response = await app.inject({
      method: "POST",
      url: `/v1/openai/${proxy.id}/chat/completions`,
      remoteAddress: "203.0.113.5",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${virtualKey}`,
      },
      payload: {
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: "hello" }],
      },
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.headers["x-archestra-pool"]).toBeUndefined();
    const [row] = await db.select().from(schema.interactionsTable);
    expect(row).toMatchObject({
      providerApiKeyId: key.id,
      modelPoolId: null,
      attempt: null,
    });
  });
});
