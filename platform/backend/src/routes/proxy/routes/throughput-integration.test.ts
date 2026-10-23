import { createServer, type Server } from "node:http";
import { eq } from "drizzle-orm";
import { http } from "msw";
import { setupServer } from "msw/node";
import config from "@/config";
import db, { schema } from "@/database";
import type { FastifyInstanceWithZod } from "@/fastify-instance";
import { createFastifyInstance } from "@/fastify-instance";
import CacheEntryModel from "@/models/cache-entry";
import LimitModel from "@/models/limit";
import LlmThroughputModel from "@/models/llm-throughput";
import ModelModel from "@/models/model";
import VirtualApiKeyModel from "@/models/virtual-api-key";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import { makePassthroughCredential } from "@/test/llm-proxy-credentials";
import { drainBackgroundWork } from "@/utils/background-work";
import anthropicProxyRoutes from "./anthropic";
import openAiProxyRoutes from "./openai";

describe("native proxy throughput", () => {
  let app: FastifyInstanceWithZod;
  let upstream: Server;
  let respond: (url: string) => Response | Promise<Response>;
  beforeEach(async () => {
    respond = () =>
      new Response("Unexpected upstream request", { status: 500 });
    upstream = createServer(async (request, reply) => {
      const response = await respond(request.url ?? "");
      reply.writeHead(response.status, Object.fromEntries(response.headers));
      if (response.body) {
        const reader = response.body.getReader();
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          reply.write(chunk.value);
        }
      }
      reply.end();
    });
    await new Promise<void>((resolve) =>
      upstream.listen(0, "127.0.0.1", resolve),
    );
    const address = upstream.address();
    if (!address || typeof address === "string")
      throw new Error("Missing test upstream");
    config.llm.openai.baseUrl = `http://127.0.0.1:${address.port}/v1`;
    config.llm.anthropic.baseUrl = `http://127.0.0.1:${address.port}`;
    app = createFastifyInstance();
    await app.register(openAiProxyRoutes);
    await app.register(anthropicProxyRoutes);
    await app.ready();
    await ModelModel.create({
      externalId: "openai/gpt-4o",
      provider: "openai",
      modelId: "gpt-4o",
      inputModalities: ["text"],
      outputModalities: ["text"],
      promptPricePerToken: "0.01",
      completionPricePerToken: "0.01",
    });
  });
  afterEach(async () => {
    await app.close();
    upstream.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      upstream.close((error) => (error ? reject(error) : resolve())),
    );
  });

  for (const storageFailure of [false, true, "tokens"] as const) {
    test(`minute Spend charges actual cost and preserves interaction accounting (storage failure ${storageFailure})`, async ({
      makeOrganization,
      makeUser,
      makeMember,
      makeAgent,
    }) => {
      const org = await makeOrganization();
      const user = await makeUser();
      await makeMember(user.id, org.id);
      const agent = await makeAgent({ organizationId: org.id });
      const key = await makePassthroughCredential({
        organizationId: org.id,
        ownerId: user.id,
      });
      const money = await LimitModel.create({
        entityType: "organization",
        entityId: org.id,
        limitType: "token_cost",
        cleanupInterval: "minute",
        limitValue: 1,
      });
      const monthly = await LimitModel.create({
        entityType: "organization",
        entityId: org.id,
        limitType: "token_cost",
        cleanupInterval: "calendar_month",
        limitValue: 100,
      });
      const tokenRule =
        storageFailure === "tokens"
          ? await LimitModel.create({
              entityType: "organization",
              entityId: org.id,
              limitType: "tokens",
              cleanupInterval: "calendar_day",
              limitValue: 1000,
            })
          : null;
      respond = async () => {
        if (storageFailure)
          await CacheEntryModel.withLock(
            `llm-throughput:${money.id}`,
            (entries) =>
              entries.set(
                tokenRule
                  ? `keyv:llm-throughput-counter-actual-tokens-v1-${tokenRule.id}`
                  : `keyv:llm-throughput-counter-${money.id}`,
                '{"value":{"version":2,"count":"corrupt"}}',
              ),
          );
        return Response.json({
          id: "minute-spend",
          object: "chat.completion",
          created: 1,
          model: "gpt-4o",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "Hello" },
              finish_reason: "stop",
            },
          ],
          usage: {
            prompt_tokens: 100,
            completion_tokens: 20,
            total_tokens: 120,
          },
        });
      };
      const request = {
        method: "POST" as const,
        url: `/v1/openai/${agent.id}/chat/completions`,
        headers: {
          authorization: "Bearer sk-test-only",
          "x-archestra-virtual-key": key,
        },
        payload: {
          model: "gpt-4o",
          messages: [{ role: "user", content: "Hello" }],
          max_tokens: 200,
        },
      };
      expect((await app.inject(request)).statusCode).toBe(
        storageFailure === "tokens" ? 503 : 200,
      );
      await drainBackgroundWork();
      const records = await db
        .select()
        .from(schema.interactionsTable)
        .where(eq(schema.interactionsTable.profileId, agent.id));
      expect(records).toHaveLength(1);
      expect(Number(records[0].cost)).toBeCloseTo(1.2);
      const monthlyUsage = (
        await LimitModel.getModelUsageBreakdowns([monthly.id])
      ).get(monthly.id);
      expect(monthlyUsage?.[0].cost).toBeCloseTo(1.2);
      const denied = await app.inject(request);
      expect(denied.statusCode).toBe(storageFailure ? 503 : 402);
      expect(denied.json().error.code).toBe(
        storageFailure
          ? "archestra_quota_storage_unavailable"
          : "token_cost_limit_exceeded",
      );
    });
  }

  for (const mode of [
    "stream",
    "partial-stream",
    "partial-known-stream",
    "provider-429",
    "raw-passthrough",
    "embedding",
  ] as const) {
    test(`accounts for ${mode} without confusing gateway and provider errors`, async ({
      makeOrganization,
      makeUser,
      makeMember,
      makeAgent,
    }) => {
      const org = await makeOrganization();
      const user = await makeUser();
      await makeMember(user.id, org.id);
      const agent = await makeAgent({ organizationId: org.id });
      const key = await makePassthroughCredential({
        organizationId: org.id,
        ownerId: user.id,
      });
      const rpm = await LimitModel.create({
        entityType: "organization",
        entityId: org.id,
        limitType: "requests_per_minute",
        limitValue: 10,
      });
      const tpm = await LimitModel.create({
        entityType: "organization",
        entityId: org.id,
        limitType: "tokens_per_minute",
        limitValue: mode === "embedding" ? 300 : 1000,
      });
      let calls = 0;
      respond = (url) => {
        calls++;
        if (url === "/v1/embeddings") {
          return Response.json({
            object: "list",
            model: "gpt-4o",
            data: [{ object: "embedding", index: 0, embedding: [0.1, 0.2] }],
            usage: { prompt_tokens: 12, total_tokens: 12 },
          });
        }
        expect(url).toBe("/v1/chat/completions");
        if (mode === "provider-429")
          return Response.json(
            {
              error: {
                message: "Provider capacity",
                type: "provider_rate_limit",
                code: "provider_busy",
              },
            },
            {
              status: 429,
              headers: {
                "retry-after": "1",
                "x-ratelimit-remaining-requests": "0",
              },
            },
          );
        const first = {
          id: "stream-test",
          object: "chat.completion.chunk",
          created: 1,
          model: "gpt-4o",
          choices: [
            { index: 0, delta: { content: "Hello" }, finish_reason: null },
          ],
        };
        const last = {
          ...first,
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          usage: {
            prompt_tokens: 100,
            completion_tokens: 20,
            total_tokens: 120,
          },
        };
        return new Response(
          `data: ${JSON.stringify(mode === "partial-known-stream" ? { ...first, usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 } } : first)}\n\n${mode === "stream" ? `data: ${JSON.stringify(last)}\n\n` : ""}data: [DONE]\n\n`,
          { headers: { "content-type": "text/event-stream" } },
        );
      };
      const started = Date.now();
      const response = await app.inject({
        method: "POST",
        url: `/v1/openai/${agent.id}/${mode === "raw-passthrough" ? "images/generations" : mode === "embedding" ? "embeddings" : "chat/completions"}`,
        headers: {
          authorization: "Bearer sk-test-only",
          "x-archestra-virtual-key": key,
        },
        payload:
          mode === "embedding"
            ? { model: "gpt-4o", input: "Hello" }
            : {
                model: "gpt-4o",
                messages: [{ role: "user", content: "Hello" }],
                max_tokens: 200,
                stream:
                  mode === "stream" ||
                  mode === "partial-stream" ||
                  mode === "partial-known-stream",
              },
      });
      const usage = await LlmThroughputModel.usage([rpm, tpm]);
      if (mode === "raw-passthrough") {
        expect(response.statusCode).toBe(400);
        expect(response.json()).toMatchObject({
          error: { code: "archestra_quota_unsupported_endpoint" },
        });
        expect(calls).toBe(0);
        expect(usage.get(rpm.id)?.currentUsage).toBe(0);
        return;
      }
      expectUsage(usage.get(rpm.id)?.currentUsage, 1, 10, Date.now() - started);
      if (mode === "embedding") {
        expect(response.statusCode, response.body).toBe(200);
        expect(calls).toBe(1);
        expectUsage(
          usage.get(tpm.id)?.currentUsage,
          12,
          300,
          Date.now() - started,
        );
        return;
      }
      if (mode === "provider-429") {
        expect(response.statusCode).toBe(429);
        expect(response.headers["retry-after"]).toBe("1");
        expect(response.json()).toMatchObject({
          error: { type: "provider_rate_limit", code: "provider_busy" },
        });
        expect(calls).toBeGreaterThanOrEqual(1);
      } else {
        expect(response.statusCode).toBe(200);
        expect(response.body).toContain("Hello");
      }
      if (mode === "stream")
        expectUsage(
          usage.get(tpm.id)?.currentUsage,
          120,
          1000,
          Date.now() - started,
        );
      else if (mode === "partial-stream")
        expect(usage.get(tpm.id)?.currentUsage).toBe(0);
      else if (mode === "partial-known-stream")
        expectUsage(
          usage.get(tpm.id)?.currentUsage,
          13,
          1000,
          Date.now() - started,
        );
      else {
        // Provider failures without reported usage consume no token allowance.
        expect(usage.get(tpm.id)?.currentUsage).toBe(0);
      }
    });
  }

  test("charges no tokens after a real client disconnect and truncated upstream without usage", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeAgent,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    await makeMember(user.id, org.id);
    const agent = await makeAgent({ organizationId: org.id });
    const key = await makePassthroughCredential({
      organizationId: org.id,
      ownerId: user.id,
    });
    const rule = await LimitModel.create({
      entityType: "organization",
      entityId: org.id,
      limitType: "tokens_per_minute",
      limitValue: 10000,
    });
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    respond = () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(stream) {
            controller = stream;
            stream.enqueue(
              new TextEncoder().encode(
                `data: ${JSON.stringify({
                  id: "disconnect",
                  object: "chat.completion.chunk",
                  created: 1,
                  model: "gpt-4o",
                  choices: [
                    {
                      index: 0,
                      delta: { content: "Hello" },
                      finish_reason: null,
                    },
                  ],
                })}\n\n`,
              ),
            );
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
    await app.listen({ port: 0, host: "127.0.0.1" });
    const address = app.server.address();
    if (!address || typeof address === "string")
      throw new Error("Missing gateway address");
    const abort = new AbortController();
    const response = await fetch(
      `http://127.0.0.1:${address.port}/v1/openai/${agent.id}/chat/completions`,
      {
        method: "POST",
        signal: abort.signal,
        headers: {
          "content-type": "application/json",
          authorization: "Bearer sk-test-only",
          "x-archestra-virtual-key": key,
        },
        body: JSON.stringify({
          model: "gpt-4o",
          max_tokens: 200,
          stream: true,
          messages: [{ role: "user", content: "Hello" }],
        }),
      },
    );
    const reader = response.body?.getReader();
    expect(new TextDecoder().decode((await reader?.read())?.value)).toContain(
      "Hello",
    );
    const reserved = (await LlmThroughputModel.usage([rule])).get(
      rule.id,
    )?.currentUsage;
    expect(reserved).toBe(0);
    abort.abort();
    controller?.close();
    await app.close();
    expectUsage(
      (await LlmThroughputModel.usage([rule])).get(rule.id)?.currentUsage,
      reserved ?? 0,
      rule.limitValue,
    );
  });

  for (const endpoint of ["responses", "responses/compact"]) {
    test(`applies quota admission to native ${endpoint}`, async ({
      makeOrganization,
      makeUser,
      makeMember,
      makeAgent,
    }) => {
      const org = await makeOrganization();
      const user = await makeUser();
      await makeMember(user.id, org.id);
      const agent = await makeAgent({ organizationId: org.id });
      const key = await makePassthroughCredential({
        organizationId: org.id,
        ownerId: user.id,
      });
      const tokenRule = await LimitModel.create({
        entityType: "organization",
        entityId: org.id,
        limitType: "tokens_per_minute",
        limitValue: 1,
      });
      const admitted = await LlmThroughputModel.admit({
        entities: [{ entityType: "organization", entityId: org.id }],
        model: "gpt-4o",
      });
      if (!("reservation" in admitted) || !admitted.reservation)
        throw new Error("Expected token accounting receipt");
      await LlmThroughputModel.reconcile({
        reservation: admitted.reservation,
        tokens: tokenRule.limitValue + 10,
      });
      let upstreamCalls = 0;
      respond = () => {
        upstreamCalls++;
        return new Response("Must not send");
      };
      const response = await app.inject({
        method: "POST",
        url: `/v1/openai/${agent.id}/${endpoint}`,
        headers: {
          authorization: "Bearer sk-test-only",
          "x-archestra-virtual-key": key,
        },
        payload: { model: "gpt-4o", input: "Hello" },
      });
      expect(response.statusCode, response.body).toBe(429);
      expect(response.json()).toMatchObject({
        error: { code: "archestra_quota_exceeded" },
      });
      expect(upstreamCalls).toBe(0);
    });
  }

  for (const finalBillingMode of ["subscription", "metered"] as const) {
    test(`counts subscription throughput against its billing team and key with final ${finalBillingMode} billing`, async ({
      makeOrganization,
      makeUser,
      makeMember,
      makeTeam,
      makeAgent,
    }) => {
      const org = await makeOrganization();
      const user = await makeUser();
      await makeMember(user.id, org.id);
      const owner = await makeTeam(org.id, user.id, { name: "Billing team" });
      const other = await makeTeam(org.id, user.id, { name: "Other team" });
      const agent = await makeAgent({ organizationId: org.id });
      const { virtualKey, value } = await VirtualApiKeyModel.create({
        organizationId: org.id,
        name: "Subscription test",
        keyType: "passthrough",
        scope: "personal",
        authorId: user.id,
        billingTeamId: owner.id,
      });
      const rules = await Promise.all(
        [
          { entityType: "team" as const, entityId: owner.id },
          { entityType: "team" as const, entityId: other.id },
          { entityType: "virtual_key" as const, entityId: virtualKey.id },
        ].map((scope) =>
          LimitModel.create({
            ...scope,
            limitType: "requests_per_minute",
            limitValue: 1,
          }),
        ),
      );
      const model = "claude-haiku-4-5-20251001";
      const spend = await LimitModel.create({
        entityType: "organization",
        entityId: org.id,
        limitType: "token_cost",
        cleanupInterval: "minute",
        limitValue: 1,
      });
      await ModelModel.create({
        externalId: `anthropic/${model}`,
        provider: "anthropic",
        modelId: model,
        inputModalities: ["text"],
        outputModalities: ["text"],
        promptPricePerToken: "0.01",
        completionPricePerToken: "0.01",
      });
      let calls = 0;
      respond = (url) => {
        expect(url).toBe("/v1/messages");
        calls++;
        return Response.json(
          {
            id: "msg_subscription",
            type: "message",
            role: "assistant",
            model,
            content: [{ type: "text", text: "Hello" }],
            stop_reason: "end_turn",
            stop_sequence: null,
            usage: { input_tokens: 10, output_tokens: 2 },
          },
          {
            headers:
              finalBillingMode === "metered"
                ? {
                    "anthropic-ratelimit-unified-status": "rejected",
                    "anthropic-ratelimit-unified-overage-status": "allowed",
                  }
                : {},
          },
        );
      };
      const request = {
        method: "POST" as const,
        url: `/v1/anthropic/${agent.id}/v1/messages`,
        headers: {
          authorization: "Bearer sk-ant-oat-test-subscription",
          "x-archestra-virtual-key": value,
          "x-archestra-team-id": other.id,
          "anthropic-version": "2023-06-01",
        },
        payload: {
          model,
          max_tokens: 50,
          messages: [{ role: "user", content: "Hello" }],
        },
      };
      // Subscription auth deliberately pins Anthropic's host instead of using
      // the configured metered-key base URL. Intercept that external boundary.
      const subscriptionProvider = setupServer(
        http.post("https://api.anthropic.com/v1/messages", () =>
          respond("/v1/messages"),
        ),
      );
      subscriptionProvider.listen({ onUnhandledRequest: "error" });
      try {
        const first = await app.inject(request);
        expect(first.statusCode, first.body).toBe(200);
        const second = await app.inject(request);
        expect(second.statusCode, second.body).toBe(429);
      } finally {
        subscriptionProvider.close();
      }
      expect(calls).toBe(1);
      const [interaction] = await db
        .select({ billingMode: schema.interactionsTable.billingMode })
        .from(schema.interactionsTable);
      expect(interaction?.billingMode).toBe(finalBillingMode);
      expectUsage(
        (await LlmThroughputModel.usage([spend])).get(spend.id)?.currentUsage,
        finalBillingMode === "metered" ? 0.12 : 0,
        spend.limitValue,
      );
      const usage = await LlmThroughputModel.usage(rules);
      for (const [index, rule] of rules.entries())
        expectUsage(
          usage.get(rule.id)?.currentUsage,
          index === 1 ? 0 : 1,
          rule.limitValue,
        );
    });
  }

  test("rejects quota with a distinct 429 and Retry-After before calling the real SDK's HTTP boundary", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeAgent,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    await makeMember(user.id, org.id);
    const agent = await makeAgent({ organizationId: org.id });
    const key = await makePassthroughCredential({
      organizationId: org.id,
      ownerId: user.id,
    });
    const rpm = await LimitModel.create({
      entityType: "organization",
      entityId: org.id,
      limitType: "requests_per_minute",
      limitValue: 1,
    });
    const tpm = await LimitModel.create({
      entityType: "organization",
      entityId: org.id,
      limitType: "tokens_per_minute",
      limitValue: 10000,
    });
    let upstreamCalls = 0;
    respond = (url) => {
      expect(url).toBe("/v1/chat/completions");
      upstreamCalls++;
      return Response.json({
        id: "test-completion",
        object: "chat.completion",
        created: 1,
        model: "gpt-4o",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "Hello" },
            finish_reason: "stop",
          },
        ],
        usage: {
          prompt_tokens: 100,
          completion_tokens: 20,
          total_tokens: 120,
        },
      });
    };
    const request = {
      method: "POST" as const,
      url: `/v1/openai/${agent.id}/chat/completions`,
      headers: {
        authorization: "Bearer sk-test-only",
        "x-archestra-virtual-key": key,
      },
      payload: {
        model: "gpt-4o",
        messages: [{ role: "user", content: "Hello" }],
        max_tokens: 200,
      },
    };
    const started = Date.now();
    expect((await app.inject(request)).statusCode).toBe(200);
    const denied = await app.inject(request);
    expect(denied.statusCode).toBe(429);
    expect(Number(denied.headers["retry-after"])).toBeGreaterThan(0);
    expect(denied.json()).toMatchObject({
      error: {
        type: "archestra_throughput_error",
        code: "archestra_quota_exceeded",
        quota: { entityType: "organization" },
      },
    });
    expect(upstreamCalls).toBe(1);
    const usage = await LlmThroughputModel.usage([rpm, tpm]);
    expectUsage(usage.get(rpm.id)?.currentUsage, 1, rpm.limitValue);
    expectUsage(
      usage.get(tpm.id)?.currentUsage,
      120,
      tpm.limitValue,
      Date.now() - started,
    );
  });
});

function expectUsage(
  actual: number | undefined,
  expected: number,
  capacity: number,
  elapsedMs = 1200,
) {
  expect(actual).toBeDefined();
  expect(actual).toBeLessThanOrEqual(expected);
  expect(actual).toBeGreaterThanOrEqual(
    Math.max(0, expected - (capacity * (elapsedMs + 100)) / 60000),
  );
}
