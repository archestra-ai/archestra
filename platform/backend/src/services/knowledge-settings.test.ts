import { vi } from "vitest";

const mockGenerateObject = vi.hoisted(() => vi.fn());
vi.mock("ai", async (importOriginal) => ({
  ...(await importOriginal<typeof import("ai")>()),
  generateObject: mockGenerateObject,
}));

vi.mock("@/clients/llm-client", () => ({
  createDirectLLMModel: vi.fn().mockReturnValue({ id: "mock-model" }),
}));

import { LlmProviderApiKeyModel } from "@/models";
import { beforeEach, describe, expect, test } from "@/test";
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
});
