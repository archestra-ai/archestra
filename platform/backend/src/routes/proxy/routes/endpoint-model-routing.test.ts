/**
 * Integration tests for endpoint selection on providers whose keys are servers.
 *
 * A vLLM key carries its own base URL and serves only the models that server
 * was started with, so which key answers a request depends on the model. Only
 * the upstream LLM client is mocked; the keys, models, and links are real.
 */

import Fastify, { type FastifyInstance } from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import type OpenAI from "openai";
import { vi } from "vitest";
import { LlmProviderApiKeyModelLinkModel, ModelModel } from "@/models";
import VirtualApiKeyModel from "@/models/virtual-api-key";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import { vllmAdapterFactory } from "../adapters/vllm";
import vllmProxyRoutes from "./vllm";

const SERVER_A_URL = "http://vllm-a:8000/v1";
const SERVER_B_URL = "http://vllm-b:8000/v1";
const MODEL_ON_A = "meta-llama/Llama-3.1-8B-Instruct";
const MODEL_ON_B = "Qwen/Qwen2.5-7B-Instruct";

describe("vLLM endpoint selection by model", () => {
  let app: FastifyInstance;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    if (app) {
      await app.close();
    }
  });

  /**
   * Records the base URL each call was made against, which is the only
   * observable difference between two vLLM servers.
   */
  async function setupRoute() {
    const calls: Array<{ baseUrl: string | undefined; model: string }> = [];
    app = Fastify().withTypeProvider<ZodTypeProvider>();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);

    vi.spyOn(vllmAdapterFactory, "createClient").mockImplementation(
      (_apiKey, options) =>
        ({
          chat: {
            completions: {
              create: async (
                request: OpenAI.Chat.Completions.ChatCompletionCreateParams,
              ) => {
                calls.push({
                  baseUrl: options.baseUrl,
                  model: request.model,
                });
                return {
                  id: "chatcmpl-endpoint-test",
                  object: "chat.completion",
                  created: 1,
                  model: request.model,
                  choices: [
                    {
                      index: 0,
                      message: {
                        role: "assistant" as const,
                        content: "Mocked response",
                        refusal: null,
                      },
                      finish_reason: "stop" as const,
                      logprobs: null,
                    },
                  ],
                  usage: {
                    prompt_tokens: 10,
                    completion_tokens: 2,
                    total_tokens: 12,
                  },
                };
              },
            },
          },
        }) as never,
    );

    await app.register(vllmProxyRoutes);
    return calls;
  }

  async function makeVllmModel(modelId: string) {
    return ModelModel.create({
      externalId: `vllm/${modelId}`,
      provider: "vllm",
      modelId,
      inputModalities: ["text"],
      outputModalities: ["text"],
    });
  }

  /** Two vLLM servers, one model each, and a virtual key mapped to server A. */
  async function seedTwoServers(params: {
    organizationId: string;
    makeSecret: (overrides?: {
      secret: Record<string, unknown>;
    }) => Promise<{ id: string }>;
    makeLlmProviderApiKey: (
      organizationId: string,
      secretId: string,
      overrides?: Record<string, unknown>,
    ) => Promise<{ id: string }>;
  }) {
    const { organizationId, makeSecret, makeLlmProviderApiKey } = params;
    const [secretA, secretB] = await Promise.all([
      makeSecret({ secret: { apiKey: "EMPTY" } }),
      makeSecret({ secret: { apiKey: "EMPTY" } }),
    ]);
    const serverA = await makeLlmProviderApiKey(organizationId, secretA.id, {
      provider: "vllm",
      baseUrl: SERVER_A_URL,
    });
    const serverB = await makeLlmProviderApiKey(organizationId, secretB.id, {
      provider: "vllm",
      baseUrl: SERVER_B_URL,
    });

    const [modelA, modelB] = await Promise.all([
      makeVllmModel(MODEL_ON_A),
      makeVllmModel(MODEL_ON_B),
    ]);
    await LlmProviderApiKeyModelLinkModel.linkModelsToApiKey(serverA.id, [
      modelA.id,
    ]);
    await LlmProviderApiKeyModelLinkModel.linkModelsToApiKey(serverB.id, [
      modelB.id,
    ]);

    const { value: tokenValue } = await VirtualApiKeyModel.create({
      organizationId,
      name: "vLLM virtual key",
      providerApiKeys: [{ provider: "vllm", providerApiKeyId: serverA.id }],
    });

    return { serverA, serverB, modelA, modelB, tokenValue };
  }

  test("routes a request to the endpoint that serves the requested model", async ({
    makeAgent,
    makeOrganization,
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    const org = await makeOrganization();
    const agent = await makeAgent({
      organizationId: org.id,
      name: "vLLM endpoint selection",
    });
    const { tokenValue } = await seedTwoServers({
      organizationId: org.id,
      makeSecret: makeSecret as never,
      makeLlmProviderApiKey: makeLlmProviderApiKey as never,
    });

    const calls = await setupRoute();
    const response = await app.inject({
      method: "POST",
      url: `/v1/vllm/${agent.id}/chat/completions`,
      headers: {
        Authorization: `Bearer ${tokenValue}`,
        "Content-Type": "application/json",
      },
      payload: {
        model: MODEL_ON_A,
        messages: [{ role: "user", content: "Hello" }],
      },
    });

    expect(response.statusCode).toBe(200);
    // The virtual key maps to server A, which is the server that carries the
    // requested model, so the call goes there with the model untouched.
    expect(calls.at(-1)).toMatchObject({
      baseUrl: SERVER_A_URL,
      model: MODEL_ON_A,
    });
  });
});
