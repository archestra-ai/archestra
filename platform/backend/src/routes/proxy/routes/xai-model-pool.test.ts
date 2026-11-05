/**
 * An xAI pool member behind a client on another route. xAI leaves reasoning
 * out of `completion_tokens`; the OpenAI and Anthropic routes count it inside
 * their output. The answer must reach the client in its own route's dialect,
 * and the turn must record reasoning as output exactly once.
 *
 * Only xAI's HTTP endpoint is mocked; routes, pool selection, translation,
 * persistence and pricing are real. Prices are $1/M input and $10/M output;
 * the member reports 1000 prompt, 100 completion and 500 reasoning tokens, so
 * the turn records 600 output tokens costing $0.007.
 */

import { eq } from "drizzle-orm";
import type { LightMyRequestResponse } from "fastify";
import { HttpResponse, http } from "msw";
import config from "@/config";
import db, { schema } from "@/database";
import { createFastifyInstance } from "@/fastify-instance";
import { ModelModel, ModelPoolModel, VirtualApiKeyModel } from "@/models";
import { accessGrants, beforeEach, expect, test } from "@/test";
import { setupTestCacheManager } from "@/test/cache-manager";
import { useMswServer } from "@/test/msw";
import anthropicRoutes from "./anthropic";
import modelRouterRoutes from "./model-router";

// biome-ignore lint/correctness/useHookAtTopLevel: Vitest lifecycle helper
const server = useMswServer();
setupTestCacheManager();
beforeEach(() => {
  config.llmProxy.modelPoolsEnabled = true;
});

const origin = "https://xai.pool.test";
const xaiUsage = {
  prompt_tokens: 1000,
  completion_tokens: 100,
  total_tokens: 1600,
  completion_tokens_details: { reasoning_tokens: 500 },
};

const poolTest = test.extend<{
  pool: {
    poolId: string;
    ask: (
      wire: "openai" | "anthropic",
      extra?: Record<string, unknown>,
    ) => Promise<LightMyRequestResponse>;
  };
}>({
  pool: async (
    { makeOrganization, makeAgent, makeSecret, makeLlmProviderApiKey },
    use,
  ) => {
    const org = await makeOrganization();
    const agent = await makeAgent({
      organizationId: org.id,
      agentType: "agent",
    });
    const key = await makeLlmProviderApiKey(
      org.id,
      (await makeSecret({ secret: { apiKey: "selected-xai-key" } })).id,
      { provider: "xai", baseUrl: origin },
    );
    const anchor = await makeLlmProviderApiKey(
      org.id,
      (await makeSecret({ secret: { apiKey: "anchor-must-not-leak" } })).id,
      { provider: "openai" },
    );
    const virtual = await VirtualApiKeyModel.create({
      organizationId: org.id,
      name: "Pool client",
      ...accessGrants("org"),
      providerApiKeys: [{ provider: "openai", providerApiKeyId: anchor.id }],
    });
    await ModelModel.create({
      provider: "xai",
      modelId: "grok-4.7",
      externalId: "xai/grok-4.7",
      inputModalities: ["text"],
      outputModalities: ["text"],
      customPricePerMillionInput: "1",
      customPricePerMillionOutput: "10",
    });
    const created = await ModelPoolModel.create({
      organizationId: org.id,
      input: {
        name: "grok-pool",
        members: [
          {
            providerApiKeyId: key.id,
            modelId: "grok-4.7",
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
      poolIds: [created.id],
    });
    const app = createFastifyInstance();
    await app.register(modelRouterRoutes);
    await app.register(anthropicRoutes);
    try {
      await use({
        poolId: created.id,
        ask: (wire, extra = {}) =>
          app.inject({
            method: "POST",
            url:
              wire === "openai"
                ? `/v1/model-router/${agent.id}/chat/completions`
                : `/v1/anthropic/${agent.id}/v1/messages`,
            headers: {
              authorization: `Bearer ${virtual.value}`,
              "anthropic-version": "2023-06-01",
            },
            payload: {
              model: "grok-pool",
              max_tokens: 32,
              messages: [{ role: "user", content: "hello" }],
              ...extra,
            },
          }),
      });
    } finally {
      await app.close();
    }
  },
});

for (const wire of ["openai", "anthropic"] as const) {
  for (const stream of [false, true]) {
    poolTest(
      `counts an xAI member's reasoning once behind a ${wire} client (stream=${stream})`,
      async ({ pool }) => {
        server.use(
          http.post(`${origin}/chat/completions`, () => {
            const base = { id: "chatcmpl-xai", created: 1, model: "grok-4.7" };
            if (!stream) {
              return HttpResponse.json({
                ...base,
                object: "chat.completion",
                choices: [
                  {
                    index: 0,
                    message: { role: "assistant", content: "pool answer" },
                    finish_reason: "stop",
                  },
                ],
                usage: xaiUsage,
              });
            }
            const chunks = [
              {
                ...base,
                object: "chat.completion.chunk",
                choices: [
                  {
                    index: 0,
                    delta: { role: "assistant", content: "pool answer" },
                    finish_reason: null,
                  },
                ],
              },
              {
                ...base,
                object: "chat.completion.chunk",
                choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
              },
              {
                ...base,
                object: "chat.completion.chunk",
                choices: [],
                usage: xaiUsage,
              },
            ];
            return new HttpResponse(
              `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`,
              { headers: { "content-type": "text/event-stream" } },
            );
          }),
        );

        const response = await pool.ask(wire, {
          stream,
          ...(stream && wire === "openai"
            ? { stream_options: { include_usage: true } }
            : {}),
        });
        expect(response.statusCode, response.body).toBe(200);
        expect(response.body).toContain("pool answer");

        // The client reads usage in its own route's dialect: reasoning inside
        // the output count.
        if (wire === "openai") {
          const usage = stream
            ? response.body
                .split("\n\n")
                .filter((line) => line.startsWith("data: {"))
                .map((line) => JSON.parse(line.slice(6)))
                .find((chunk) => chunk.usage)?.usage
            : response.json().usage;
          expect(usage).toMatchObject({
            completion_tokens: 600,
            total_tokens: 1600,
            completion_tokens_details: { reasoning_tokens: 500 },
          });
        } else if (!stream) {
          expect(response.json().usage).toMatchObject({ output_tokens: 600 });
        }

        const rows = await db
          .select()
          .from(schema.interactionsTable)
          .where(eq(schema.interactionsTable.modelPoolId, pool.poolId));
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
          model: "grok-4.7",
          outputTokens: 600,
          attemptOutcome: "answered",
        });
        expect(Number(rows[0].cost)).toBeCloseTo(0.007, 6);
      },
    );
  }
}
