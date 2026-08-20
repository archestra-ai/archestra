import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import { vi } from "vitest";
import { ModelModel, VirtualApiKeyModel } from "@/models";
import type { ModelInfo } from "@/routes/chat/model-fetchers/types";
import { describe, expect, test } from "@/test";
import { ApiError } from "@/types";

vi.mock("@/routes/chat/model-fetchers/anthropic", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/routes/chat/model-fetchers/anthropic")
  >()),
  fetchAnthropicModels: vi.fn(),
}));
vi.mock(
  "@/routes/chat/model-fetchers/github-copilot",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@/routes/chat/model-fetchers/github-copilot")
    >()),
    fetchGithubCopilotModels: vi.fn(),
  }),
);
vi.mock("@/routes/chat/model-fetchers/openai", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/routes/chat/model-fetchers/openai")
  >()),
  fetchOpenAiModels: vi.fn(),
}));

import { fetchAnthropicModels } from "@/routes/chat/model-fetchers/anthropic";
import { fetchGithubCopilotModels } from "@/routes/chat/model-fetchers/github-copilot";
import { fetchOpenAiModels } from "@/routes/chat/model-fetchers/openai";
import anthropicProxyRoutes from "./anthropic";
import githubCopilotProxyRoutes from "./github-copilot";
import openAiProxyRoutes from "./openai";
import {
  AnthropicModelsListResponseSchema,
  toAnthropicModelsList,
} from "./proxy-model-listing";

async function buildApp(
  plugin:
    | typeof anthropicProxyRoutes
    | typeof openAiProxyRoutes
    | typeof githubCopilotProxyRoutes,
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

  // Claude Code's gateway model discovery keeps only the ids this endpoint
  // returns, so without the synthesized `[1m]` siblings a client configured
  // with a long-context variant silently drops to the base id on first
  // connect.
  test("anthropic: appends a [1m] sibling for Claude models the catalog records a 1M window for", async () => {
    await ModelModel.upsert({
      externalId: "anthropic/claude-opus-5",
      provider: "anthropic",
      modelId: "claude-opus-5",
      inputModalities: null,
      outputModalities: null,
      contextLength: 1_000_000,
      lastSyncedAt: new Date(),
    });
    await ModelModel.upsert({
      externalId: "anthropic/claude-haiku-4-5",
      provider: "anthropic",
      modelId: "claude-haiku-4-5",
      inputModalities: null,
      outputModalities: null,
      contextLength: 200_000,
      lastSyncedAt: new Date(),
    });
    vi.mocked(fetchAnthropicModels).mockResolvedValue([
      {
        id: "claude-opus-5",
        displayName: "Claude Opus 5",
        provider: "anthropic",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
      {
        id: "claude-haiku-4-5",
        displayName: "Claude Haiku 4.5",
        provider: "anthropic",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
      {
        // No catalog row at all: no window is known, so no sibling.
        id: "claude-uncatalogued",
        displayName: "Claude Uncatalogued",
        provider: "anthropic",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ]);
    const app = await buildApp(anthropicProxyRoutes);

    const response = await app.inject({
      method: "GET",
      url: `/v1/anthropic/${randomUUID()}/v1/models`,
      headers: { "x-api-key": "sk-ant-raw" },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      data: Array<{ id: string; display_name: string }>;
    };
    // The sibling sits directly after its base id; sub-1M and uncatalogued
    // models get none.
    expect(body.data.map((model) => model.id)).toEqual([
      "claude-opus-5",
      "claude-opus-5[1m]",
      "claude-haiku-4-5",
      "claude-uncatalogued",
    ]);
    expect(
      body.data.find((model) => model.id === "claude-opus-5[1m]")?.display_name,
    ).toBe("Claude Opus 5 (1M context)");
  });

  test("anthropic: an admin-set window decides the [1m] sibling", async () => {
    // Both directions of the override: a model the catalog under-reports gains
    // the sibling, and one an admin pinned below 1M loses it.
    await ModelModel.upsert({
      externalId: "anthropic/claude-opus-5",
      provider: "anthropic",
      modelId: "claude-opus-5",
      inputModalities: null,
      outputModalities: null,
      contextLength: 1_000_000,
      lastSyncedAt: new Date(),
    });
    await ModelModel.upsert({
      externalId: "anthropic/claude-haiku-4-5",
      provider: "anthropic",
      modelId: "claude-haiku-4-5",
      inputModalities: null,
      outputModalities: null,
      contextLength: 200_000,
      lastSyncedAt: new Date(),
    });
    const opus = await ModelModel.findByProviderAndModelId(
      "anthropic",
      "claude-opus-5",
    );
    const haiku = await ModelModel.findByProviderAndModelId(
      "anthropic",
      "claude-haiku-4-5",
    );
    // Asserted rather than defaulted: an update against a missing id is a
    // no-op, which would leave the synced windows in place and pass.
    expect(opus).not.toBeNull();
    expect(haiku).not.toBeNull();
    await ModelModel.update(opus?.id ?? "", { customContextLength: 200_000 });
    await ModelModel.update(haiku?.id ?? "", {
      customContextLength: 1_000_000,
    });

    vi.mocked(fetchAnthropicModels).mockResolvedValue([
      {
        id: "claude-opus-5",
        displayName: "Claude Opus 5",
        provider: "anthropic",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
      {
        id: "claude-haiku-4-5",
        displayName: "Claude Haiku 4.5",
        provider: "anthropic",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ]);
    const app = await buildApp(anthropicProxyRoutes);

    const response = await app.inject({
      method: "GET",
      url: `/v1/anthropic/${randomUUID()}/v1/models`,
      headers: { "x-api-key": "sk-ant-raw" },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as { data: Array<{ id: string }> };
    expect(body.data.map((model) => model.id)).toEqual([
      "claude-opus-5",
      "claude-haiku-4-5",
      "claude-haiku-4-5[1m]",
    ]);
  });

  test("anthropic: does not duplicate a variant id the upstream already lists", async () => {
    await ModelModel.upsert({
      externalId: "anthropic/claude-opus-5",
      provider: "anthropic",
      modelId: "claude-opus-5",
      inputModalities: null,
      outputModalities: null,
      contextLength: 1_000_000,
      lastSyncedAt: new Date(),
    });
    vi.mocked(fetchAnthropicModels).mockResolvedValue([
      {
        id: "claude-opus-5",
        displayName: "Claude Opus 5",
        provider: "anthropic",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
      {
        id: "claude-opus-5[1m]",
        displayName: "Claude Opus 5 (1M context)",
        provider: "anthropic",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ]);
    const app = await buildApp(anthropicProxyRoutes);

    const response = await app.inject({
      method: "GET",
      url: `/v1/anthropic/${randomUUID()}/v1/models`,
      headers: { "x-api-key": "sk-ant-raw" },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as { data: Array<{ id: string }> };
    expect(body.data.map((model) => model.id)).toEqual([
      "claude-opus-5",
      "claude-opus-5[1m]",
    ]);
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

  test("github-copilot: reports the serving provider in owned_by, not openai", async ({
    makeOrganization,
    makeSecret,
    makeLlmProviderApiKey,
    makeUser,
  }) => {
    // The list helper used to hardcode owned_by: "openai" — right on the
    // OpenAI route by coincidence, wrong here, and contradicting the model
    // router, which reports owned_by: "github-copilot" for the same models.
    vi.mocked(fetchGithubCopilotModels).mockResolvedValue([
      {
        id: "gpt-4o",
        displayName: "GPT-4o",
        provider: "github-copilot",
        createdAt: "2025-01-01T00:00:00.000Z",
      },
      {
        id: "gpt-5.3-codex",
        displayName: "gpt-5.3-codex",
        provider: "github-copilot",
      },
    ]);
    const app = await buildApp(githubCopilotProxyRoutes);

    // A Copilot credential is per-user, and llm-proxy-auth re-checks at
    // request time that both the virtual key and the mapped provider key are
    // the same user's personal keys — so the fixture must model real
    // ownership, not just a mapping.
    const org = await makeOrganization();
    const owner = await makeUser();
    const secret = await makeSecret({ secret: { apiKey: "gho_real_token" } });
    const providerKey = await makeLlmProviderApiKey(org.id, secret.id, {
      provider: "github-copilot",
      scope: "personal",
      userId: owner.id,
    });
    const { value } = await VirtualApiKeyModel.create({
      name: "vk-copilot",
      scope: "personal",
      authorId: owner.id,
      providerApiKeys: [
        { provider: "github-copilot", providerApiKeyId: providerKey.id },
      ],
    });

    const response = await app.inject({
      method: "GET",
      url: `/v1/github-copilot/${randomUUID()}/models`,
      headers: { authorization: `Bearer ${value}` },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as { data: Array<{ owned_by: string }> };
    expect(body.data).toHaveLength(2);
    for (const model of body.data) {
      expect(model.owned_by).toBe("github-copilot");
    }
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

describe("toAnthropicModelsList display_name fallback", () => {
  test("falls back to the model id when displayName is missing at runtime", () => {
    // Rows built from a non-Anthropic-shaped upstream listing (base-URL
    // override) can lack display_name; one bare row used to fail the whole
    // response against AnthropicModelsListResponseSchema as a 500.
    const models = [
      { id: "claude-sonnet-5", provider: "anthropic" },
      { id: "custom-model", displayName: "Custom", provider: "anthropic" },
    ] as unknown as Parameters<typeof toAnthropicModelsList>[0];

    const listed = toAnthropicModelsList(models);
    expect(listed.data.map((m) => m.display_name)).toEqual([
      "claude-sonnet-5",
      "Custom",
    ]);
    expect(() => AnthropicModelsListResponseSchema.parse(listed)).not.toThrow();
  });
});
