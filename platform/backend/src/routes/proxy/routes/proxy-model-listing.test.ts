import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import { vi } from "vitest";
import { VirtualApiKeyModel } from "@/models";
import type { ModelInfo } from "@/routes/chat/model-fetchers/types";
import { describe, expect, test } from "@/test";
import { ApiError } from "@/types";

vi.mock("@/routes/chat/model-fetchers/anthropic", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/routes/chat/model-fetchers/anthropic")
  >()),
  fetchAnthropicModels: vi.fn(),
}));
vi.mock("@/routes/chat/model-fetchers/openai", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/routes/chat/model-fetchers/openai")
  >()),
  fetchOpenAiModels: vi.fn(),
}));

import { fetchAnthropicModels } from "@/routes/chat/model-fetchers/anthropic";
import { fetchOpenAiModels } from "@/routes/chat/model-fetchers/openai";
import anthropicProxyRoutes from "./anthropic";
import openAiProxyRoutes from "./openai";

async function buildApp(
  plugin: typeof anthropicProxyRoutes | typeof openAiProxyRoutes,
) {
  const app = Fastify().withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ApiError) {
      return reply
        .status(error.statusCode)
        .send({ error: { message: error.message, type: error.type } });
    }
    return reply.status(500).send({
      error: {
        message: error instanceof Error ? error.message : String(error),
        type: "api_internal_server_error",
      },
    });
  });
  await app.register(plugin);
  return app;
}

const ANTHROPIC_MODELS: ModelInfo[] = [
  {
    id: "claude-sonnet-4-6",
    displayName: "Claude Sonnet 4.6",
    provider: "anthropic",
    createdAt: "2025-01-01T00:00:00.000Z",
  },
];

const OPENAI_MODELS: ModelInfo[] = [
  {
    id: "gpt-5.4",
    displayName: "GPT-5.4",
    provider: "openai",
    createdAt: "2025-01-01T00:00:00.000Z",
  },
];

describe("provider-specific proxy GET /models (virtual-key-aware)", () => {
  test("anthropic: resolves the virtual key to the real provider key and returns the native models shape", async ({
    makeOrganization,
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    vi.mocked(fetchAnthropicModels).mockResolvedValue(ANTHROPIC_MODELS);
    const app = await buildApp(anthropicProxyRoutes);

    const org = await makeOrganization();
    const secret = await makeSecret({ secret: { apiKey: "sk-ant-real" } });
    const providerKey = await makeLlmProviderApiKey(org.id, secret.id, {
      provider: "anthropic",
    });
    const { value } = await VirtualApiKeyModel.create({
      name: "vk-anthropic",
      providerApiKeys: [
        { provider: "anthropic", providerApiKeyId: providerKey.id },
      ],
    });

    const response = await app.inject({
      method: "GET",
      url: `/v1/anthropic/${randomUUID()}/v1/models?limit=100`,
      headers: { "x-api-key": value, "anthropic-version": "2023-06-01" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      data: [
        {
          type: "model",
          id: "claude-sonnet-4-6",
          display_name: "Claude Sonnet 4.6",
          created_at: "2025-01-01T00:00:00.000Z",
        },
      ],
      has_more: false,
    });
    expect(fetchAnthropicModels).toHaveBeenCalledWith(
      "sk-ant-real",
      undefined,
      null,
    );
  });

  test("anthropic: discovery targets the provider's canonical baseUrl, not the inference override", async ({
    makeOrganization,
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    vi.mocked(fetchAnthropicModels).mockResolvedValue(ANTHROPIC_MODELS);
    const app = await buildApp(anthropicProxyRoutes);

    const org = await makeOrganization();
    const secret = await makeSecret({ secret: { apiKey: "sk-ant-real" } });
    // A custom inference gateway that does not serve /models: discovery must use
    // baseUrl, never inferenceBaseUrl.
    const providerKey = await makeLlmProviderApiKey(org.id, secret.id, {
      provider: "anthropic",
      baseUrl: "https://discovery.example.com",
      inferenceBaseUrl: "https://inference.example.com",
    });
    const { value } = await VirtualApiKeyModel.create({
      name: "vk-anthropic-discovery-base",
      providerApiKeys: [
        { provider: "anthropic", providerApiKeyId: providerKey.id },
      ],
    });

    const response = await app.inject({
      method: "GET",
      url: `/v1/anthropic/${randomUUID()}/v1/models`,
      headers: { "x-api-key": value },
    });

    expect(response.statusCode).toBe(200);
    expect(fetchAnthropicModels).toHaveBeenCalledWith(
      "sk-ant-real",
      "https://discovery.example.com",
      null,
    );
  });

  test("anthropic: discovery falls back to the provider default when only inferenceBaseUrl is set", async ({
    makeOrganization,
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    vi.mocked(fetchAnthropicModels).mockResolvedValue(ANTHROPIC_MODELS);
    const app = await buildApp(anthropicProxyRoutes);

    const org = await makeOrganization();
    const secret = await makeSecret({ secret: { apiKey: "sk-ant-real" } });
    // baseUrl null + inferenceBaseUrl set: discovery must not borrow the
    // inference override; it falls back to the provider default (undefined).
    const providerKey = await makeLlmProviderApiKey(org.id, secret.id, {
      provider: "anthropic",
      baseUrl: null,
      inferenceBaseUrl: "https://inference.example.com",
    });
    const { value } = await VirtualApiKeyModel.create({
      name: "vk-anthropic-inference-only",
      providerApiKeys: [
        { provider: "anthropic", providerApiKeyId: providerKey.id },
      ],
    });

    const response = await app.inject({
      method: "GET",
      url: `/v1/anthropic/${randomUUID()}/v1/models`,
      headers: { "x-api-key": value },
    });

    expect(response.statusCode).toBe(200);
    expect(fetchAnthropicModels).toHaveBeenCalledWith(
      "sk-ant-real",
      undefined,
      null,
    );
  });

  test("anthropic: default-agent route lists models", async ({
    makeOrganization,
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    vi.mocked(fetchAnthropicModels).mockResolvedValue(ANTHROPIC_MODELS);
    const app = await buildApp(anthropicProxyRoutes);

    const org = await makeOrganization();
    const secret = await makeSecret({ secret: { apiKey: "sk-ant-real" } });
    const providerKey = await makeLlmProviderApiKey(org.id, secret.id, {
      provider: "anthropic",
    });
    const { value } = await VirtualApiKeyModel.create({
      name: "vk-anthropic-default",
      providerApiKeys: [
        { provider: "anthropic", providerApiKeyId: providerKey.id },
      ],
    });

    const response = await app.inject({
      method: "GET",
      url: "/v1/anthropic/v1/models",
      headers: { "x-api-key": value },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data).toHaveLength(1);
  });

  test("anthropic: an invalid arch_ key is rejected with 401 and never reaches the fetcher", async () => {
    const app = await buildApp(anthropicProxyRoutes);

    const response = await app.inject({
      method: "GET",
      url: `/v1/anthropic/${randomUUID()}/v1/models`,
      headers: { "x-api-key": `arch_${"0".repeat(64)}` },
    });

    expect(response.statusCode).toBe(401);
    expect(fetchAnthropicModels).not.toHaveBeenCalled();
  });

  test("anthropic: a raw (non-arch_) key is passed through to the upstream fetcher", async () => {
    vi.mocked(fetchAnthropicModels).mockResolvedValue(ANTHROPIC_MODELS);
    const app = await buildApp(anthropicProxyRoutes);

    const response = await app.inject({
      method: "GET",
      url: `/v1/anthropic/${randomUUID()}/v1/models`,
      headers: { "x-api-key": "sk-ant-raw" },
    });

    expect(response.statusCode).toBe(200);
    expect(fetchAnthropicModels).toHaveBeenCalledWith(
      "sk-ant-raw",
      undefined,
      null,
    );
  });

  test("openai: resolves a Bearer virtual key and returns the native OpenAI models shape", async ({
    makeOrganization,
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    vi.mocked(fetchOpenAiModels).mockResolvedValue(OPENAI_MODELS);
    const app = await buildApp(openAiProxyRoutes);

    const org = await makeOrganization();
    const secret = await makeSecret({ secret: { apiKey: "sk-openai-real" } });
    const providerKey = await makeLlmProviderApiKey(org.id, secret.id, {
      provider: "openai",
    });
    const { value } = await VirtualApiKeyModel.create({
      name: "vk-openai",
      providerApiKeys: [
        { provider: "openai", providerApiKeyId: providerKey.id },
      ],
    });

    const response = await app.inject({
      method: "GET",
      url: `/v1/openai/${randomUUID()}/models`,
      headers: { authorization: `Bearer ${value}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      object: "list",
      data: [
        {
          id: "gpt-5.4",
          object: "model",
          created: Math.floor(
            new Date("2025-01-01T00:00:00.000Z").getTime() / 1000,
          ),
          owned_by: "openai",
        },
      ],
    });
    expect(fetchOpenAiModels).toHaveBeenCalledWith(
      "sk-openai-real",
      undefined,
      null,
    );
  });

  test("openai: default-agent route lists models", async ({
    makeOrganization,
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    vi.mocked(fetchOpenAiModels).mockResolvedValue(OPENAI_MODELS);
    const app = await buildApp(openAiProxyRoutes);

    const org = await makeOrganization();
    const secret = await makeSecret({ secret: { apiKey: "sk-openai-real" } });
    const providerKey = await makeLlmProviderApiKey(org.id, secret.id, {
      provider: "openai",
    });
    const { value } = await VirtualApiKeyModel.create({
      name: "vk-openai-default",
      providerApiKeys: [
        { provider: "openai", providerApiKeyId: providerKey.id },
      ],
    });

    const response = await app.inject({
      method: "GET",
      url: "/v1/openai/models",
      headers: { authorization: `Bearer ${value}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data).toHaveLength(1);
  });

  test("openai: a missing key is rejected with 401", async () => {
    const app = await buildApp(openAiProxyRoutes);

    const response = await app.inject({
      method: "GET",
      url: "/v1/openai/models",
    });

    expect(response.statusCode).toBe(401);
    expect(fetchOpenAiModels).not.toHaveBeenCalled();
  });
});
