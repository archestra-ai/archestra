/**
 * Model pool failover on the LLM proxy, end to end through the OpenAI route.
 * The provider is stubbed at the adapter-client boundary: the pool's first
 * member is rate limited, the second answers.
 */

import Fastify, { type FastifyInstance } from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import { vi } from "vitest";
import config from "@/config";
import db, { schema } from "@/database";
import { ModelModel, ModelPoolModel, VirtualApiKeyModel } from "@/models";
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
          virtualApiKeyIds: [virtualKeyRow.id],
        },
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
    await ModelPoolModel.create({
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
        virtualApiKeyIds: [virtualKeyRow.id],
      },
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
