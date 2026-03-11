import { vi } from "vitest";

const mockGetSecretValue = vi.hoisted(() => vi.fn());
vi.mock("@/secrets-manager", () => ({
  getSecretValueForLlmProviderApiKey: mockGetSecretValue,
}));

const mockCreateDirectLLMModel = vi.hoisted(() =>
  vi.fn().mockReturnValue({ id: "mock-llm-model" }),
);
vi.mock("@/clients/llm-client", () => ({
  createDirectLLMModel: mockCreateDirectLLMModel,
}));

vi.mock("openai", () => {
  class MockOpenAI {
    apiKey: string;
    baseURL?: string;
    constructor(opts: { apiKey: string; baseURL?: string }) {
      this.apiKey = opts.apiKey;
      this.baseURL = opts.baseURL;
    }
  }
  return { default: MockOpenAI };
});

import db, { schema } from "@/database";
import { ChatApiKeyModel, OrganizationModel } from "@/models";
import { describe, expect, test } from "@/test";
import {
  getDefaultOrgEmbeddingConfig,
  resolveEmbeddingConfig,
  resolveRerankerConfig,
} from "./kb-llm-client";

async function createSecret(): Promise<string> {
  const [secret] = await db
    .insert(schema.secretsTable)
    .values({ secret: { access_token: "test-secret" } })
    .returning();
  return secret.id;
}

describe("resolveEmbeddingConfig", () => {
  test("returns config when org has embedding key and model configured", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const secretId = await createSecret();

    const chatApiKey = await ChatApiKeyModel.create({
      organizationId: org.id,
      name: "OpenAI Key",
      provider: "openai",
      secretId,
      scope: "org_wide",
      userId: null,
      teamId: null,
    });

    await OrganizationModel.patch(org.id, {
      embeddingChatApiKeyId: chatApiKey.id,
      embeddingModel: "text-embedding-3-small",
    });

    mockGetSecretValue.mockResolvedValueOnce("sk-test-key-123");

    const result = await resolveEmbeddingConfig(org.id);

    expect(result).not.toBeNull();
    expect(result?.model).toBe("text-embedding-3-small");
    expect(result?.dimensions).toBeGreaterThan(0);
  });

  test("returns null when org has no embedding key configured", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();

    const result = await resolveEmbeddingConfig(org.id);

    expect(result).toBeNull();
  });

  test("returns null when org has key but no embedding model", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const secretId = await createSecret();

    const chatApiKey = await ChatApiKeyModel.create({
      organizationId: org.id,
      name: "OpenAI Key",
      provider: "openai",
      secretId,
      scope: "org_wide",
      userId: null,
      teamId: null,
    });

    await OrganizationModel.patch(org.id, {
      embeddingChatApiKeyId: chatApiKey.id,
    });

    const result = await resolveEmbeddingConfig(org.id);

    expect(result).toBeNull();
  });

  test("returns config with placeholder key when chat API key has no secretId", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();

    const chatApiKey = await ChatApiKeyModel.create({
      organizationId: org.id,
      name: "OpenAI Key (no secret)",
      provider: "openai",
      secretId: null,
      scope: "org_wide",
      userId: null,
      teamId: null,
    });

    await OrganizationModel.patch(org.id, {
      embeddingChatApiKeyId: chatApiKey.id,
      embeddingModel: "text-embedding-3-small",
    });

    const result = await resolveEmbeddingConfig(org.id);

    expect(result).not.toBeNull();
    expect(result?.model).toBe("text-embedding-3-small");
    expect(result?.dimensions).toBe(1536);
    expect(result?.client.apiKey).toBe("unused");
  });

  test("returns null when secret value cannot be resolved", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const secretId = await createSecret();

    const chatApiKey = await ChatApiKeyModel.create({
      organizationId: org.id,
      name: "OpenAI Key",
      provider: "openai",
      secretId,
      scope: "org_wide",
      userId: null,
      teamId: null,
    });

    await OrganizationModel.patch(org.id, {
      embeddingChatApiKeyId: chatApiKey.id,
      embeddingModel: "text-embedding-3-small",
    });

    mockGetSecretValue.mockResolvedValueOnce(null);

    const result = await resolveEmbeddingConfig(org.id);

    expect(result).toBeNull();
  });

  test("returns null for non-existent organization", async () => {
    const result = await resolveEmbeddingConfig(
      "00000000-0000-0000-0000-000000000000",
    );

    expect(result).toBeNull();
  });
});

describe("resolveRerankerConfig", () => {
  test("returns config when org has reranker key and model configured", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const secretId = await createSecret();

    const chatApiKey = await ChatApiKeyModel.create({
      organizationId: org.id,
      name: "Reranker Key",
      provider: "openai",
      secretId,
      scope: "org_wide",
      userId: null,
      teamId: null,
    });

    await OrganizationModel.patch(org.id, {
      rerankerChatApiKeyId: chatApiKey.id,
      rerankerModel: "rerank-v3",
    });

    mockGetSecretValue.mockResolvedValueOnce("sk-reranker-key");

    const result = await resolveRerankerConfig(org.id);

    expect(result).not.toBeNull();
    expect(result?.modelName).toBe("rerank-v3");
    expect(mockCreateDirectLLMModel).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: "sk-reranker-key",
        modelName: "rerank-v3",
      }),
    );
  });

  test("returns null when org has no reranker key configured", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();

    const result = await resolveRerankerConfig(org.id);

    expect(result).toBeNull();
  });

  test("returns null when org has reranker key but no model", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const secretId = await createSecret();

    const chatApiKey = await ChatApiKeyModel.create({
      organizationId: org.id,
      name: "Key",
      provider: "openai",
      secretId,
      scope: "org_wide",
      userId: null,
      teamId: null,
    });

    await OrganizationModel.patch(org.id, {
      rerankerChatApiKeyId: chatApiKey.id,
    });

    const result = await resolveRerankerConfig(org.id);

    expect(result).toBeNull();
  });

  test("returns null when secret resolution fails", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const secretId = await createSecret();

    const chatApiKey = await ChatApiKeyModel.create({
      organizationId: org.id,
      name: "Key",
      provider: "openai",
      secretId,
      scope: "org_wide",
      userId: null,
      teamId: null,
    });

    await OrganizationModel.patch(org.id, {
      rerankerChatApiKeyId: chatApiKey.id,
      rerankerModel: "rerank-v3",
    });

    mockGetSecretValue.mockResolvedValueOnce(null);

    const result = await resolveRerankerConfig(org.id);

    expect(result).toBeNull();
  });
});

describe("getDefaultOrgEmbeddingConfig", () => {
  test("returns config when first org has embedding configured", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const secretId = await createSecret();

    const chatApiKey = await ChatApiKeyModel.create({
      organizationId: org.id,
      name: "OpenAI Key",
      provider: "openai",
      secretId,
      scope: "org_wide",
      userId: null,
      teamId: null,
    });

    await OrganizationModel.patch(org.id, {
      embeddingChatApiKeyId: chatApiKey.id,
      embeddingModel: "text-embedding-3-small",
    });

    mockGetSecretValue.mockResolvedValueOnce("sk-test-key");

    const result = await getDefaultOrgEmbeddingConfig();

    expect(result).not.toBeNull();
    expect(result?.organizationId).toBe(org.id);
    expect(result?.config.model).toBe("text-embedding-3-small");
  });

  test("returns null when org has no embedding config", async ({
    makeOrganization,
  }) => {
    await makeOrganization();

    const result = await getDefaultOrgEmbeddingConfig();

    expect(result).toBeNull();
  });
});
