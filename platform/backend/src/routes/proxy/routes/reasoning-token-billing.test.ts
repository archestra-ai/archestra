/**
 * Reasoning tokens a provider reports OUTSIDE its output count (Gemini's
 * thoughtsTokenCount, xAI's reasoning_tokens) are billed as output, so the
 * recorded interaction must count and price them as output, and each client
 * must read the turn's usage in its own surface's dialect.
 *
 * Real proxy routes and pricing; only the upstream SDK client is stubbed.
 * Prices are $1/M input and $10/M output; every turn reports 1000 input,
 * 100 visible output and 500 reasoning tokens, so it records 600 output
 * tokens costing 1000 * 1e-6 + 600 * 10e-6 = $0.007.
 */

import { desc } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { vi } from "vitest";
import db, { schema } from "@/database";
import {
  createFastifyInstance,
  type FastifyInstanceWithZod,
} from "@/fastify-instance";
import {
  LlmProviderApiKeyModelLinkModel,
  ModelModel,
  VirtualApiKeyModel,
} from "@/models";
import { afterEach, describe, expect, test } from "@/test";
import { makePassthroughCredential } from "@/test/llm-proxy-credentials";
import { geminiAdapterFactory } from "../adapters/gemini";
import { xaiAdapterFactory } from "../adapters/xai";
import geminiProxyRoutes from "./gemini";
import modelRouterRoutes from "./model-router";
import xaiProxyRoutes from "./xai";

const PRICES = {
  customPricePerMillionInput: "1.00",
  customPricePerMillionOutput: "10.00",
};
const EXPECTED = { outputTokens: 600, cost: 0.007 };

const apps: FastifyInstanceWithZod[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("reasoning tokens reported outside output are billed as output", () => {
  for (const streaming of [false, true]) {
    test(`gemini ${streaming ? "streaming" : "non-streaming"}`, async ({
      makeAgent,
      makeUser,
      makeMember,
    }) => {
      const final = {
        candidates: [
          {
            content: { role: "model", parts: [{ text: "Answer" }] },
            finishReason: "STOP",
            index: 0,
          },
        ],
        usageMetadata: {
          promptTokenCount: 1000,
          candidatesTokenCount: 100,
          thoughtsTokenCount: 500,
          totalTokenCount: 1600,
        },
        modelVersion: "gemini-2.5-pro",
        responseId: "gemini-thinking",
      };
      vi.spyOn(geminiAdapterFactory, "createClient").mockImplementation(
        () =>
          ({
            models: {
              generateContent: async () => final,
              generateContentStream: async () => ({
                async *[Symbol.asyncIterator]() {
                  yield {
                    candidates: [
                      {
                        content: { role: "model", parts: [{ text: "An" }] },
                        index: 0,
                      },
                    ],
                    responseId: final.responseId,
                    modelVersion: final.modelVersion,
                  };
                  yield final;
                },
              }),
            },
          }) as never,
      );
      await ModelModel.upsert({
        externalId: "gemini/gemini-2.5-pro",
        provider: "gemini",
        modelId: "gemini-2.5-pro",
        inputModalities: null,
        outputModalities: null,
        ...PRICES,
        lastSyncedAt: new Date(),
      });
      const app = await appWith(geminiProxyRoutes);
      const agent = await makeAgent({ name: "Gemini thinking" });
      const owner = await makeUser();
      await makeMember(owner.id, agent.organizationId);

      const response = await app.inject({
        method: "POST",
        url: `/v1/gemini/${agent.id}/v1beta/models/gemini-2.5-pro:${
          streaming ? "streamGenerateContent?alt=sse" : "generateContent"
        }`,
        headers: {
          "content-type": "application/json",
          "x-goog-api-key": "test-key",
          "x-archestra-virtual-key": await makePassthroughCredential({
            organizationId: agent.organizationId,
            ownerId: owner.id,
          }),
        },
        payload: { contents: [{ role: "user", parts: [{ text: "Hi" }] }] },
      });
      expect(response.statusCode, response.body).toBe(200);

      await expectBilledAsOutput();
    });
  }

  // xAI's wire: total_tokens = prompt + completion + reasoning. Its own route
  // hands that on as is; the model router and the Responses surfaces speak
  // OpenAI's dialect, where completion/output tokens include reasoning.
  const xaiUsage = {
    prompt_tokens: 1000,
    completion_tokens: 100,
    total_tokens: 1600,
    completion_tokens_details: { reasoning_tokens: 500 },
  };
  const surfaces = [
    {
      name: "xai chat completions",
      route: "xai",
      path: "chat/completions",
      model: "grok-4.7",
      clientUsage: { completion_tokens: 100, total_tokens: 1600 },
    },
    {
      name: "xai responses",
      route: "xai",
      path: "responses",
      model: "grok-4.7",
      clientUsage: { output_tokens: 600, total_tokens: 1600 },
    },
    {
      name: "model router chat completions",
      route: "model-router",
      path: "chat/completions",
      model: "xai:grok-4.7",
      clientUsage: { completion_tokens: 600, total_tokens: 1600 },
    },
    {
      name: "model router responses",
      route: "model-router",
      path: "responses",
      model: "xai:grok-4.7",
      clientUsage: { output_tokens: 600, total_tokens: 1600 },
    },
  ] as const;

  for (const surface of surfaces) {
    for (const streaming of [false, true]) {
      test(`${surface.name} ${streaming ? "streaming" : "non-streaming"}`, async ({
        makeAgent,
        makeSecret,
        makeLlmProviderApiKey,
      }) => {
        stubXai(xaiUsage);
        const agent = await makeAgent({
          name: "xAI reasoning",
          agentType: "llm_proxy",
        });
        const token = await xaiVirtualKey({
          organizationId: agent.organizationId,
          makeSecret,
          makeLlmProviderApiKey,
        });
        const app = await appWith(
          surface.route === "xai" ? xaiProxyRoutes : modelRouterRoutes,
        );

        const isResponses = surface.path === "responses";
        const response = await app.inject({
          method: "POST",
          url: `/v1/${surface.route}/${agent.id}/${surface.path}`,
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${token}`,
          },
          payload: isResponses
            ? { model: surface.model, input: "Hi", stream: streaming }
            : {
                model: surface.model,
                stream: streaming,
                ...(streaming
                  ? { stream_options: { include_usage: true } }
                  : {}),
                messages: [{ role: "user", content: "Hi" }],
              },
        });
        expect(response.statusCode, response.body).toBe(200);

        expect(
          clientUsageOf(response, { streaming, isResponses }),
        ).toMatchObject(surface.clientUsage);
        await expectBilledAsOutput();
      });
    }
  }
});

async function appWith(routes: FastifyPluginAsyncZod) {
  const app = createFastifyInstance();
  apps.push(app);
  await app.register(routes);
  return app;
}

function stubXai(usage: Record<string, unknown>) {
  vi.spyOn(xaiAdapterFactory, "createClient").mockImplementation(
    () =>
      ({
        chat: {
          completions: {
            create: async (request: { model: string; stream?: boolean }) => {
              const base = {
                id: "chatcmpl-xai",
                created: 1,
                model: request.model,
              };
              if (!request.stream) {
                return {
                  ...base,
                  object: "chat.completion",
                  choices: [
                    {
                      index: 0,
                      message: {
                        role: "assistant",
                        content: "Answer",
                        refusal: null,
                      },
                      finish_reason: "stop",
                      logprobs: null,
                    },
                  ],
                  usage,
                };
              }
              return {
                async *[Symbol.asyncIterator]() {
                  yield {
                    ...base,
                    object: "chat.completion.chunk",
                    choices: [
                      {
                        index: 0,
                        delta: { role: "assistant", content: "Answer" },
                        finish_reason: null,
                      },
                    ],
                  };
                  yield {
                    ...base,
                    object: "chat.completion.chunk",
                    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
                  };
                  yield {
                    ...base,
                    object: "chat.completion.chunk",
                    choices: [],
                    usage,
                  };
                },
              };
            },
          },
        },
      }) as never,
  );
}

/** A virtual key serving `grok-4.7` from one priced xAI key. */
async function xaiVirtualKey(params: {
  organizationId: string;
  makeSecret: (...args: never[]) => Promise<{ id: string }>;
  makeLlmProviderApiKey: (...args: never[]) => Promise<{ id: string }>;
}) {
  const makeSecret = params.makeSecret as () => Promise<{ id: string }>;
  const makeKey = params.makeLlmProviderApiKey as (
    organizationId: string,
    secretId: string,
    overrides: Record<string, unknown>,
  ) => Promise<{ id: string }>;
  const secret = await makeSecret();
  const key = await makeKey(params.organizationId, secret.id, {
    provider: "xai",
    isPrimary: true,
  });
  const model = await ModelModel.upsert({
    externalId: "xai/grok-4.7",
    provider: "xai",
    modelId: "grok-4.7",
    inputModalities: ["text"],
    outputModalities: ["text"],
    ...PRICES,
    lastSyncedAt: new Date(),
  });
  await LlmProviderApiKeyModelLinkModel.linkModelsToApiKey(key.id, [model.id]);
  const { value } = await VirtualApiKeyModel.create({
    organizationId: params.organizationId,
    name: "xAI reasoning",
    providerApiKeys: [{ provider: "xai", providerApiKeyId: key.id }],
  });
  return value;
}

/** The usage the client read: the final body, or the stream's usage event. */
function clientUsageOf(
  response: { body: string; json: () => Record<string, unknown> },
  params: { streaming: boolean; isResponses: boolean },
) {
  if (!params.streaming) return response.json().usage;
  const events = response.body
    .split("\n")
    .filter((line) => line.startsWith("data: {"))
    .map((line) => JSON.parse(line.slice(6)));
  return params.isResponses
    ? events.find((event) => event.type === "response.completed")?.response
        ?.usage
    : events.find((event) => event.usage)?.usage;
}

async function expectBilledAsOutput() {
  await vi.waitFor(async () => {
    const [interaction] = await db
      .select()
      .from(schema.interactionsTable)
      .orderBy(desc(schema.interactionsTable.createdAt))
      .limit(1);
    expect(interaction).toBeDefined();
    expect(interaction.outputTokens).toBe(EXPECTED.outputTokens);
    expect(Number(interaction.cost)).toBeCloseTo(EXPECTED.cost, 6);
  });
}
