import { vi } from "vitest";

const mockGenerateObject = vi.hoisted(() => vi.fn());
const mockGenerateText = vi.hoisted(() => vi.fn());
vi.mock("ai", async (importOriginal) => ({
  ...(await importOriginal<typeof import("ai")>()),
  generateObject: mockGenerateObject,
  generateText: mockGenerateText,
}));

vi.mock("@/clients/llm-client", () => ({
  createDirectLLMModel: vi.fn().mockReturnValue({ id: "mock-model" }),
}));

import { HttpResponse, http } from "msw";
import { LlmProviderApiKeyModel, ModelModel } from "@/models";
import { beforeEach, describe, expect, test } from "@/test";
import { useMswServer } from "@/test/msw";
import { knowledgeSettingsService } from "./knowledge-settings";

describe("knowledgeSettingsService.validateRerankerConfig", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("returns not-found when the key does not exist", async () => {
    const result = await knowledgeSettingsService.validateRerankerConfig({
      keyId: "00000000-0000-0000-0000-000000000000",
      model: "gemini-1.5-flash",
      organizationId: "11111111-1111-1111-1111-111111111111",
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("could not be found");
  });

  test("returns not-found when the key belongs to another org", async ({
    makeOrganization,
    makeSecret,
  }) => {
    const org = await makeOrganization();
    const otherOrg = await makeOrganization();
    const secret = await makeSecret({ secret: { apiKey: "k" } });
    const key = await LlmProviderApiKeyModel.create({
      organizationId: org.id,
      secretId: secret.id,
      name: "Reranker Key",
      provider: "gemini",
      scope: "org",
      userId: null,
    });

    const result = await knowledgeSettingsService.validateRerankerConfig({
      keyId: key.id,
      model: "gemini-1.5-flash",
      organizationId: otherOrg.id,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("could not be found");
    // The foreign key must never reach the provider (no credential spend).
    expect(mockGenerateObject).not.toHaveBeenCalled();
  });

  test("passes when the model returns structured scores", async ({
    makeOrganization,
    makeSecret,
  }) => {
    const org = await makeOrganization();
    const secret = await makeSecret({ secret: { apiKey: "k" } });
    const key = await LlmProviderApiKeyModel.create({
      organizationId: org.id,
      secretId: secret.id,
      name: "Reranker Key",
      provider: "gemini",
      scope: "org",
      userId: null,
    });
    mockGenerateObject.mockResolvedValue({
      object: { scores: [{ index: 0, score: 8 }] },
    });

    const result = await knowledgeSettingsService.validateRerankerConfig({
      keyId: key.id,
      model: "gemini-1.5-flash",
      organizationId: org.id,
    });
    expect(result.ok).toBe(true);
  });

  test("fails when the structured-output call throws", async ({
    makeOrganization,
    makeSecret,
  }) => {
    const org = await makeOrganization();
    const secret = await makeSecret({ secret: { apiKey: "k" } });
    const key = await LlmProviderApiKeyModel.create({
      organizationId: org.id,
      secretId: secret.id,
      name: "Reranker Key",
      provider: "gemini",
      scope: "org",
      userId: null,
    });
    mockGenerateObject.mockRejectedValue(new Error("model does not exist"));

    const result = await knowledgeSettingsService.validateRerankerConfig({
      keyId: key.id,
      model: "not-a-real-model",
      organizationId: org.id,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe(
      "Failed to verify reranker model. Raw error: model does not exist",
    );
  });

  test("rejects a rerank-only model when the provider has no executable route", async ({
    makeOrganization,
    makeSecret,
  }) => {
    const org = await makeOrganization();
    const secret = await makeSecret({ secret: { apiKey: "k" } });
    const key = await LlmProviderApiKeyModel.create({
      organizationId: org.id,
      secretId: secret.id,
      name: "Reranker Key",
      provider: "gemini",
      scope: "org",
      userId: null,
    });
    const result = await knowledgeSettingsService.validateRerankerConfig({
      keyId: key.id,
      model: "my-rerank-model",
      organizationId: org.id,
    });
    expect(result).toEqual({
      ok: false,
      error:
        "This provider and model cannot be used for Knowledge reranking. Select a model listed for this API key.",
    });
    expect(mockGenerateObject).not.toHaveBeenCalled();
  });

  describe("native rerank models", () => {
    const server = useMswServer();

    const makeAzureRerankKey = async (fixtures: {
      makeOrganization: () => Promise<{ id: string }>;
      makeSecret: (params: {
        secret: Record<string, string>;
      }) => Promise<{ id: string }>;
    }) => {
      const org = await fixtures.makeOrganization();
      const secret = await fixtures.makeSecret({ secret: { apiKey: "k" } });
      const key = await LlmProviderApiKeyModel.create({
        organizationId: org.id,
        secretId: secret.id,
        name: "Azure Foundry Key",
        provider: "azure",
        baseUrl: "https://my-resource.cognitiveservices.azure.com/openai/v1",
        scope: "org",
        userId: null,
      });
      return { org, key };
    };

    test("verifies through the provider's native rerank route, not chat completions", async ({
      makeOrganization,
      makeSecret,
    }) => {
      const { org, key } = await makeAzureRerankKey({
        makeOrganization,
        makeSecret,
      });
      server.use(
        http.post(
          "https://my-resource.cognitiveservices.azure.com/providers/cohere/v2/rerank",
          () =>
            HttpResponse.json({
              results: [{ index: 0, relevance_score: 0.9 }],
            }),
        ),
      );

      const result = await knowledgeSettingsService.validateRerankerConfig({
        keyId: key.id,
        model: "Cohere-rerank-v4.0-fast",
        organizationId: org.id,
      });
      expect(result).toEqual({ ok: true });
      expect(mockGenerateObject).not.toHaveBeenCalled();
    });

    test("surfaces the rerank API's error without the chat-model hint", async ({
      makeOrganization,
      makeSecret,
    }) => {
      const { org, key } = await makeAzureRerankKey({
        makeOrganization,
        makeSecret,
      });
      server.use(
        http.post(
          "https://my-resource.cognitiveservices.azure.com/providers/cohere/v2/rerank",
          () =>
            HttpResponse.json(
              { error: { message: "unauthorized" } },
              { status: 401 },
            ),
        ),
      );

      const result = await knowledgeSettingsService.validateRerankerConfig({
        keyId: key.id,
        model: "Cohere-rerank-v4.0-fast",
        organizationId: org.id,
      });
      expect(result.ok).toBe(false);
      expect(result.error).toContain("unauthorized");
      // The native route IS the right way to call this model; steering the
      // user to a chat model here would be wrong.
      expect(result.error).not.toContain("select a chat model");
    });
  });
});

describe("knowledgeSettingsService.validateOcrConfig", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("returns not-found when the key belongs to another org, before any spend", async ({
    makeOrganization,
    makeSecret,
  }) => {
    const org = await makeOrganization();
    const otherOrg = await makeOrganization();
    const secret = await makeSecret({ secret: { apiKey: "k" } });
    const key = await LlmProviderApiKeyModel.create({
      organizationId: org.id,
      secretId: secret.id,
      name: "OCR Key",
      provider: "anthropic",
      scope: "org",
      userId: null,
    });

    const result = await knowledgeSettingsService.validateOcrConfig({
      keyId: key.id,
      model: "claude-sonnet-5",
      organizationId: otherOrg.id,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("could not be found");
    expect(mockGenerateText).not.toHaveBeenCalled();
  });

  test("rejects a provider whose transport cannot carry PDF input", async ({
    makeOrganization,
    makeSecret,
  }) => {
    const org = await makeOrganization();
    const secret = await makeSecret({ secret: { apiKey: "k" } });
    const key = await LlmProviderApiKeyModel.create({
      organizationId: org.id,
      secretId: secret.id,
      name: "Native Ollama Key",
      provider: "ollama-native",
      scope: "org",
      userId: null,
    });

    const result = await knowledgeSettingsService.validateOcrConfig({
      keyId: key.id,
      model: "llava",
      organizationId: org.id,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("cannot send PDF pages");
    expect(mockGenerateText).not.toHaveBeenCalled();
  });

  test("rejects a text-only model before spending a probe call", async ({
    makeOrganization,
    makeSecret,
  }) => {
    const org = await makeOrganization();
    const secret = await makeSecret({ secret: { apiKey: "k" } });
    const key = await LlmProviderApiKeyModel.create({
      organizationId: org.id,
      secretId: secret.id,
      name: "OCR Key",
      provider: "anthropic",
      scope: "org",
      userId: null,
    });
    await ModelModel.create({
      externalId: "anthropic/claude-text-only",
      provider: "anthropic",
      modelId: "claude-text-only",
      description: "Text-only model",
      contextLength: null,
      inputModalities: ["text"],
      outputModalities: [],
      supportsToolCalling: false,
      promptPricePerToken: null,
      completionPricePerToken: null,
      embeddingDimensions: null,
      lastSyncedAt: new Date(),
    });

    const result = await knowledgeSettingsService.validateOcrConfig({
      keyId: key.id,
      model: "claude-text-only",
      organizationId: org.id,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("text-only");
    expect(mockGenerateText).not.toHaveBeenCalled();
  });

  test("passes when the model accepts the probe PDF", async ({
    makeOrganization,
    makeSecret,
  }) => {
    const org = await makeOrganization();
    const secret = await makeSecret({ secret: { apiKey: "k" } });
    const key = await LlmProviderApiKeyModel.create({
      organizationId: org.id,
      secretId: secret.id,
      name: "OCR Key",
      provider: "anthropic",
      scope: "org",
      userId: null,
    });
    mockGenerateText.mockResolvedValue({ text: "OK" });

    const result = await knowledgeSettingsService.validateOcrConfig({
      keyId: key.id,
      model: "claude-sonnet-5",
      organizationId: org.id,
    });
    expect(result.ok).toBe(true);
    // The probe sent an application/pdf file part.
    const call = mockGenerateText.mock.calls[0][0];
    const parts = call.messages[0].content;
    expect(
      parts.some(
        (part: { type: string; mediaType?: string }) =>
          part.type === "file" && part.mediaType === "application/pdf",
      ),
    ).toBe(true);
  });

  test("surfaces a probe failure as a validation error", async ({
    makeOrganization,
    makeSecret,
  }) => {
    const org = await makeOrganization();
    const secret = await makeSecret({ secret: { apiKey: "k" } });
    const key = await LlmProviderApiKeyModel.create({
      organizationId: org.id,
      secretId: secret.id,
      name: "OCR Key",
      provider: "anthropic",
      scope: "org",
      userId: null,
    });
    mockGenerateText.mockRejectedValue(
      new Error("file parts are not supported"),
    );

    const result = await knowledgeSettingsService.validateOcrConfig({
      keyId: key.id,
      model: "claude-sonnet-5",
      organizationId: org.id,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("file parts are not supported");
  });
});
