/**
 * Reasoning tokens a provider reports OUTSIDE its output count (Gemini's
 * thoughtsTokenCount, xAI's reasoning_tokens) are billed as output, so the
 * recorded interaction must count and price them as output.
 *
 * Real proxy routes and pricing; only the upstream SDK client is stubbed.
 * Prices are $1/M input and $10/M output; every turn reports 1000 input,
 * 100 visible output and 500 reasoning tokens, so it records 600 output
 * tokens costing 1000 * 1e-6 + 600 * 10e-6 = $0.007.
 */

import { vi } from "vitest";
import { createFastifyInstance } from "@/fastify-instance";
import { InteractionModel, ModelModel } from "@/models";
import { afterEach, describe, expect, test } from "@/test";
import { makePassthroughCredential } from "@/test/llm-proxy-credentials";
import { geminiAdapterFactory } from "../adapters/gemini";
import { xaiAdapterFactory } from "../adapters/xai";
import geminiProxyRoutes from "./gemini";
import xaiProxyRoutes from "./xai";

const PRICES = {
  customPricePerMillionInput: "1.00",
  customPricePerMillionOutput: "10.00",
};
const EXPECTED = { outputTokens: 600, cost: 0.007 };

afterEach(() => {
  vi.restoreAllMocks();
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
      const app = createFastifyInstance();
      await app.register(geminiProxyRoutes);
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

      await expectBilledAsOutput(agent.id);
      await app.close();
    });
  }

  for (const streaming of [false, true]) {
    test(`xai ${streaming ? "streaming" : "non-streaming"}`, async ({
      makeAgent,
      makeUser,
      makeMember,
    }) => {
      // xAI's wire: total_tokens = prompt + completion + reasoning.
      const usage = {
        prompt_tokens: 1000,
        completion_tokens: 100,
        total_tokens: 1600,
        completion_tokens_details: { reasoning_tokens: 500 },
      };
      vi.spyOn(xaiAdapterFactory, "createClient").mockImplementation(
        () =>
          ({
            chat: {
              completions: {
                create: async (request: {
                  model: string;
                  stream?: boolean;
                }) => {
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
                        choices: [
                          { index: 0, delta: {}, finish_reason: "stop" },
                        ],
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
      await ModelModel.upsert({
        externalId: "xai/grok-4.7",
        provider: "xai",
        modelId: "grok-4.7",
        inputModalities: null,
        outputModalities: null,
        ...PRICES,
        lastSyncedAt: new Date(),
      });
      const app = createFastifyInstance();
      await app.register(xaiProxyRoutes);
      const agent = await makeAgent({ name: "xAI reasoning" });
      const owner = await makeUser();
      await makeMember(owner.id, agent.organizationId);

      const response = await app.inject({
        method: "POST",
        url: `/v1/xai/${agent.id}/chat/completions`,
        headers: {
          "content-type": "application/json",
          authorization: "Bearer test-key",
          "x-archestra-virtual-key": await makePassthroughCredential({
            organizationId: agent.organizationId,
            ownerId: owner.id,
          }),
        },
        payload: {
          model: "grok-4.7",
          stream: streaming,
          ...(streaming ? { stream_options: { include_usage: true } } : {}),
          messages: [{ role: "user", content: "Hi" }],
        },
      });
      expect(response.statusCode, response.body).toBe(200);

      // The client gets xAI's own usage either way: reasoning beside
      // completion_tokens, not inside it.
      const clientUsage = streaming
        ? response.body
            .split("\n\n")
            .filter((line) => line.startsWith("data: {"))
            .map((line) => JSON.parse(line.slice(6)))
            .find((chunk) => chunk.usage)?.usage
        : response.json().usage;
      expect(clientUsage).toMatchObject(usage);

      await expectBilledAsOutput(agent.id);
      await app.close();
    });
  }
});

async function expectBilledAsOutput(agentId: string) {
  await vi.waitFor(async () => {
    const [interaction] =
      await InteractionModel.getAllInteractionsForProfile(agentId);
    expect(interaction).toBeDefined();
    expect(interaction.outputTokens).toBe(EXPECTED.outputTokens);
    expect(Number(interaction.cost)).toBeCloseTo(EXPECTED.cost, 6);
  });
}
