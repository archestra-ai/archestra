/**
 * One credential mapped to several OpenAI-compatible endpoints on the native
 * `/v1/vllm` route: each request must reach the endpoint whose server hosts
 * the requested model, with that endpoint's own key. The upstream is stubbed
 * at the adapter-client boundary.
 */

import { LLM_PROXY_OAUTH_SCOPE } from "@archestra/shared";
import Fastify, { type FastifyInstance } from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import { vi } from "vitest";
import config from "@/config";
import {
  LlmOauthClientModel,
  LlmProviderApiKeyModelLinkModel,
  ModelModel,
  VirtualApiKeyModel,
} from "@/models";
import authRoutes from "@/routes/auth";
import {
  accessGrants,
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "@/test";
import { createOpenAiTestClient } from "@/test/llm-provider-stubs";
import type { Agent } from "@/types";
import { vllmAdapterFactory } from "../adapters";
import vllmProxyRoutes from "./vllm";

const ENDPOINTS = [
  { name: "glm", modelId: "glm-5.3" },
  { name: "deepseek", modelId: "deepseek-v4.1-flash" },
] as const;

describe("vLLM proxy with several mapped endpoints", () => {
  let app: FastifyInstance;
  let agent: Agent;
  let providerApiKeyIds: string[];
  const originalVllm = { ...config.llm.vllm };

  beforeEach(async ({ makeAgent, makeSecret, makeLlmProviderApiKey }) => {
    // The route needs a default upstream to register; mapped keys override it.
    config.llm.vllm.enabled = true;
    config.llm.vllm.baseUrl = "https://default.vllm.test/v1";
    vi.spyOn(vllmAdapterFactory, "createClient").mockImplementation(
      () => createOpenAiTestClient() as never,
    );
    app = Fastify().withTypeProvider<ZodTypeProvider>();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    await app.register(authRoutes);
    await app.register(vllmProxyRoutes);

    agent = await makeAgent({ agentType: "llm_proxy" });
    providerApiKeyIds = [];
    for (const { name, modelId } of ENDPOINTS) {
      await ModelModel.upsert({
        externalId: `vllm/${modelId}`,
        provider: "vllm",
        modelId,
        inputModalities: ["text"],
        outputModalities: ["text"],
        customPricePerMillionInput: "1.00",
        customPricePerMillionOutput: "1.00",
        lastSyncedAt: new Date(),
      });
      const model = await ModelModel.findByProviderAndModelId("vllm", modelId);
      if (!model) throw new Error(`model ${modelId} was not upserted`);
      const secret = await makeSecret({ secret: { apiKey: `sk-${name}` } });
      const key = await makeLlmProviderApiKey(agent.organizationId, secret.id, {
        name: `${name} gateway`,
        provider: "vllm",
        baseUrl: `https://${name}.gateway.test/v1`,
      });
      await LlmProviderApiKeyModelLinkModel.linkModelsToApiKey(key.id, [
        model.id,
      ]);
      providerApiKeyIds.push(key.id);
    }
  });

  afterEach(async () => {
    Object.assign(config.llm.vllm, originalVllm);
    vi.restoreAllMocks();
    await app.close();
  });

  test("routes each model to its endpoint for a virtual key", async () => {
    const { value } = await VirtualApiKeyModel.create({
      name: "two-vllm-endpoints-vk",
      providerApiKeys: providerApiKeyIds.map((providerApiKeyId) => ({
        provider: "vllm" as const,
        providerApiKeyId,
      })),
      ...accessGrants("org"),
    });

    for (const model of ["deepseek-v4.1-flash", "glm-5.3"]) {
      expect((await send({ token: value, model })).statusCode).toBe(200);
    }
    // An unknown model falls back to the first mapped endpoint.
    expect((await send({ token: value, model: "unknown" })).statusCode).toBe(
      200,
    );

    expect(vllmClientCalls()).toEqual([
      ["sk-deepseek", "https://deepseek.gateway.test/v1"],
      ["sk-glm", "https://glm.gateway.test/v1"],
      ["sk-glm", "https://glm.gateway.test/v1"],
    ]);
  });

  test("streams each model from its endpoint for a virtual key", async () => {
    const { value } = await VirtualApiKeyModel.create({
      name: "two-vllm-endpoints-stream-vk",
      providerApiKeys: providerApiKeyIds.map((providerApiKeyId) => ({
        provider: "vllm" as const,
        providerApiKeyId,
      })),
      ...accessGrants("org"),
    });

    for (const model of ["glm-5.3", "deepseek-v4.1-flash"]) {
      const response = await send({ token: value, model, stream: true });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.body).toContain("data: [DONE]");
    }

    expect(vllmClientCalls()).toEqual([
      ["sk-glm", "https://glm.gateway.test/v1"],
      ["sk-deepseek", "https://deepseek.gateway.test/v1"],
    ]);
  });

  test("routes each model to its endpoint for LLM OAuth client credentials", async () => {
    const { oauthClient, clientSecret } = await LlmOauthClientModel.create({
      organizationId: agent.organizationId,
      authorId: crypto.randomUUID(),
      name: "Two Endpoint Service",
      providerApiKeys: providerApiKeyIds.map((providerApiKeyId) => ({
        provider: "vllm" as const,
        providerApiKeyId,
      })),
    });
    const tokenResponse = await app.inject({
      method: "POST",
      url: "/api/auth/oauth2/token",
      payload: {
        grant_type: "client_credentials",
        client_id: oauthClient.clientId,
        client_secret: clientSecret,
        scope: LLM_PROXY_OAUTH_SCOPE,
      },
    });
    expect(tokenResponse.statusCode, tokenResponse.body).toBe(200);
    const { access_token: accessToken } = tokenResponse.json();

    for (const model of ["glm-5.3", "deepseek-v4.1-flash"]) {
      const response = await send({ token: accessToken, model });
      expect(response.statusCode, response.body).toBe(200);
    }

    expect(vllmClientCalls()).toEqual([
      ["sk-glm", "https://glm.gateway.test/v1"],
      ["sk-deepseek", "https://deepseek.gateway.test/v1"],
    ]);
  });

  function send(params: { token: string; model: string; stream?: boolean }) {
    return app.inject({
      method: "POST",
      url: `/v1/vllm/${agent.id}/chat/completions`,
      // Non-loopback: the credential, not a localhost bypass, authorizes it.
      remoteAddress: "203.0.113.5",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${params.token}`,
      },
      payload: {
        model: params.model,
        stream: params.stream ?? false,
        messages: [{ role: "user", content: "Hello" }],
      },
    });
  }
});

/** `[apiKey, baseUrl]` of every vLLM client the proxy built, in order. */
function vllmClientCalls() {
  return vi
    .mocked(vllmAdapterFactory.createClient)
    .mock.calls.map(([apiKey, options]) => [apiKey, options.baseUrl]);
}
