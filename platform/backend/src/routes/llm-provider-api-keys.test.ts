import { vi } from "vitest";
import LlmProviderApiKeyModelLinkModel from "@/models/llm-provider-api-key-model";
import ModelModel from "@/models/model";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";
import { ApiError } from "@/types";

// Mock the Vertex AI check
vi.mock("@/clients/gemini-client", () => ({
  isVertexAiEnabled: vi.fn(),
}));

// Mock auth for permission checks
vi.mock("@/auth", () => ({
  hasPermission: vi.fn(),
  userHasPermission: vi.fn(),
}));

// Mock testProviderApiKey to avoid external calls
vi.mock("@/routes/chat/model-fetchers/registry", () => ({
  testProviderApiKey: vi.fn(async (provider, _, baseUrl) => {
    if (provider === "bedrock" && !baseUrl) {
      throw new Error("Bedrock base URL not configured");
    }
  }),
}));

// Mock secrets-manager to use real DB-backed SecretModel for FK integrity
vi.mock("@/secrets-manager", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/secrets-manager")>();
  const { default: SecretModel } = await import("@/models/secret");
  return {
    ...actual,
    isByosEnabled: vi.fn().mockReturnValue(false),
    secretManager: vi.fn().mockReturnValue({
      createSecret: vi
        .fn()
        .mockImplementation(
          async (secret: Record<string, unknown>, name: string) =>
            SecretModel.create({ name, secret }),
        ),
      updateSecret: vi.fn(),
      deleteSecret: vi.fn(),
    }),
  };
});

// Mock model sync service
vi.mock("@/services/model-sync", () => ({
  modelSyncService: {
    syncModelsForApiKey: vi.fn(),
  },
}));

import { hasPermission, userHasPermission } from "@/auth";
import { isVertexAiEnabled } from "@/clients/gemini-client";
import { validateProviderAllowed } from "./llm-provider-api-keys";

const mockIsVertexAiEnabled = vi.mocked(isVertexAiEnabled);
const mockHasPermission = vi.mocked(hasPermission);
const mockUserHasPermission = vi.mocked(userHasPermission);

describe("validateProviderAllowed", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("throws error when creating Gemini API key with Vertex AI enabled", () => {
    mockIsVertexAiEnabled.mockReturnValue(true);

    expect(() => validateProviderAllowed("gemini")).toThrow(ApiError);
    expect(() => validateProviderAllowed("gemini")).toThrow(
      "Cannot create Gemini API key: Vertex AI is configured",
    );
  });

  test("allows Gemini API key creation when Vertex AI is disabled", () => {
    mockIsVertexAiEnabled.mockReturnValue(false);

    expect(() => validateProviderAllowed("gemini")).not.toThrow();
  });

  test("allows OpenAI API key creation regardless of Vertex AI status", () => {
    mockIsVertexAiEnabled.mockReturnValue(true);

    expect(() => validateProviderAllowed("openai")).not.toThrow();
  });

  test("allows Anthropic API key creation regardless of Vertex AI status", () => {
    mockIsVertexAiEnabled.mockReturnValue(true);

    expect(() => validateProviderAllowed("anthropic")).not.toThrow();
  });
});

// === Helper to create a Fastify app with admin auth for route tests ===

function setupAdminApp() {
  mockIsVertexAiEnabled.mockReturnValue(false);
  mockUserHasPermission.mockResolvedValue(true);
  mockHasPermission.mockResolvedValue({ success: true } as never);
}

function setupMemberApp() {
  mockIsVertexAiEnabled.mockReturnValue(false);
  mockUserHasPermission.mockResolvedValue(false);
  mockHasPermission.mockResolvedValue({ success: false } as never);
}

async function createApp(orgId: string, currentUser: User) {
  const app = createFastifyInstance();
  app.addHook("onRequest", async (request) => {
    (
      request as typeof request & {
        organizationId: string;
        user: User;
      }
    ).organizationId = orgId;
    (request as typeof request & { user: User }).user = currentUser;
  });

  const { default: llmProviderApiKeyRoutes } = await import(
    "./llm-provider-api-keys"
  );
  const { default: organizationRoutes } = await import("./organization");
  await app.register(llmProviderApiKeyRoutes);
  await app.register(organizationRoutes);
  return app;
}

describe("GET /api/llm-provider-api-keys/available", () => {
  let app: FastifyInstanceWithZod;
  let organizationId: string;
  let user: User;

  beforeEach(async ({ makeOrganization, makeUser }) => {
    vi.clearAllMocks();
    const organization = await makeOrganization();
    organizationId = organization.id;
    user = await makeUser();
    setupAdminApp();
    app = await createApp(organizationId, user);
  });

  afterEach(async () => {
    await app.close();
  });

  test("loads best models in a single batched call", async ({
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    const secret = await makeSecret();
    const apiKey = await makeLlmProviderApiKey(organizationId, secret.id, {
      provider: "openai",
      scope: "personal",
      userId: user.id,
    });
    const model = await ModelModel.create({
      externalId: "openai/gpt-4o",
      provider: "openai",
      modelId: "gpt-4o",
      description: "GPT-4o",
      contextLength: 128000,
      inputModalities: ["text"],
      outputModalities: ["text"],
      supportsToolCalling: true,
      promptPricePerToken: "0.000005",
      completionPricePerToken: "0.000015",
      lastSyncedAt: new Date(),
    });

    const getBestModelsForApiKeysSpy = vi
      .spyOn(LlmProviderApiKeyModelLinkModel, "getBestModelsForApiKeys")
      .mockResolvedValue(new Map([[apiKey.id, model]]));
    const getBestModelSpy = vi.spyOn(
      LlmProviderApiKeyModelLinkModel,
      "getBestModel",
    );

    const response = await app.inject({
      method: "GET",
      url: "/api/llm-provider-api-keys/available",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject([
      {
        id: apiKey.id,
        bestModelId: "gpt-4o",
      },
    ]);
    expect(getBestModelsForApiKeysSpy).toHaveBeenCalledWith([apiKey.id]);
    expect(getBestModelSpy).not.toHaveBeenCalled();
  });
});

describe("LLM Provider API Keys CRUD", () => {
  let app: FastifyInstanceWithZod;
  let organizationId: string;
  let user: User;

  beforeEach(async ({ makeOrganization, makeUser, makeMember }) => {
    vi.clearAllMocks();
    setupAdminApp();

    const organization = await makeOrganization();
    organizationId = organization.id;
    user = await makeUser();
    await makeMember(user.id, organizationId, { role: "admin" });

    app = await createApp(organizationId, user);
  });

  afterEach(async () => {
    await app.close();
  });

  test("should list LLM provider API keys (initially empty)", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/llm-provider-api-keys",
    });

    expect(response.statusCode).toBe(200);
    expect(Array.isArray(response.json())).toBe(true);
  });

  test("should create a personal LLM provider API key", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/llm-provider-api-keys",
      payload: {
        name: "Test Anthropic Key",
        provider: "anthropic",
        apiKey: "sk-ant-test-key-12345",
        scope: "personal",
      },
    });

    expect(response.json()).toMatchObject({ name: "Test Anthropic Key" });
    expect(response.statusCode).toBe(200);
    const apiKey = response.json();

    expect(apiKey).toHaveProperty("id");
    expect(apiKey.name).toBe("Test Anthropic Key");
    expect(apiKey.provider).toBe("anthropic");
    expect(apiKey.scope).toBe("personal");
    expect(apiKey.secretId).toBeDefined();
  });

  test("should create an org-wide LLM provider API key", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/llm-provider-api-keys",
      payload: {
        name: "Org Wide Test Key",
        provider: "anthropic",
        apiKey: "sk-ant-org-wide-test-key",
        scope: "org",
      },
    });

    expect(response.statusCode).toBe(200);
    const apiKey = response.json();
    expect(apiKey.scope).toBe("org");
  });

  test("should get a specific LLM provider API key by ID", async () => {
    const createResponse = await app.inject({
      method: "POST",
      url: "/api/llm-provider-api-keys",
      payload: {
        name: "Get By ID Test Key",
        provider: "anthropic",
        apiKey: "sk-ant-get-by-id-test",
        scope: "personal",
      },
    });
    const createdKey = createResponse.json();

    const response = await app.inject({
      method: "GET",
      url: `/api/llm-provider-api-keys/${createdKey.id}`,
    });

    expect(response.statusCode).toBe(200);
    const apiKey = response.json();
    expect(apiKey.id).toBe(createdKey.id);
    expect(apiKey.name).toBe("Get By ID Test Key");
  });

  test("should update an LLM provider API key name", async () => {
    const createResponse = await app.inject({
      method: "POST",
      url: "/api/llm-provider-api-keys",
      payload: {
        name: "Original Name",
        provider: "anthropic",
        apiKey: "sk-ant-update-test",
        scope: "personal",
      },
    });
    const createdKey = createResponse.json();

    const updateResponse = await app.inject({
      method: "PATCH",
      url: `/api/llm-provider-api-keys/${createdKey.id}`,
      payload: {
        name: "Updated Name",
      },
    });

    expect(updateResponse.statusCode).toBe(200);
    const updatedKey = updateResponse.json();
    expect(updatedKey.name).toBe("Updated Name");
  });

  test("should delete an LLM provider API key", async () => {
    const createResponse = await app.inject({
      method: "POST",
      url: "/api/llm-provider-api-keys",
      payload: {
        name: "Delete Test Key",
        provider: "anthropic",
        apiKey: "sk-ant-delete-test",
        scope: "personal",
      },
    });
    const createdKey = createResponse.json();

    const deleteResponse = await app.inject({
      method: "DELETE",
      url: `/api/llm-provider-api-keys/${createdKey.id}`,
    });

    expect(deleteResponse.statusCode).toBe(200);
    const result = deleteResponse.json();
    expect(result.success).toBe(true);

    // Verify it's deleted
    const getResponse = await app.inject({
      method: "GET",
      url: `/api/llm-provider-api-keys/${createdKey.id}`,
    });
    expect(getResponse.statusCode).toBe(404);
  });

  test("should return 404 for non-existent LLM provider API key", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/llm-provider-api-keys/00000000-0000-0000-0000-000000000000",
    });

    expect(response.statusCode).toBe(404);
  });

  test("should allow multiple personal keys per user per provider", async () => {
    const key1Response = await app.inject({
      method: "POST",
      url: "/api/llm-provider-api-keys",
      payload: {
        name: "Personal Anthropic Key 1",
        provider: "anthropic",
        apiKey: "sk-ant-personal-test-1",
        scope: "personal",
      },
    });
    expect(key1Response.statusCode).toBe(200);

    const key2Response = await app.inject({
      method: "POST",
      url: "/api/llm-provider-api-keys",
      payload: {
        name: "Personal Anthropic Key 2",
        provider: "anthropic",
        apiKey: "sk-ant-personal-test-2",
        scope: "personal",
      },
    });
    expect(key2Response.statusCode).toBe(200);
  });

  test("should allow personal keys for different providers", async () => {
    const anthropicResponse = await app.inject({
      method: "POST",
      url: "/api/llm-provider-api-keys",
      payload: {
        name: "Personal Anthropic Key",
        provider: "anthropic",
        apiKey: "sk-ant-multi-provider-test",
        scope: "personal",
      },
    });
    expect(anthropicResponse.statusCode).toBe(200);

    const openaiResponse = await app.inject({
      method: "POST",
      url: "/api/llm-provider-api-keys",
      payload: {
        name: "Personal OpenAI Key",
        provider: "openai",
        apiKey: "sk-openai-multi-provider-test",
        scope: "personal",
      },
    });
    expect(openaiResponse.statusCode).toBe(200);
  });

  test("prevent creating API keys with empty base URL for providers that require it", async () => {
    const createResponse = await app.inject({
      method: "POST",
      url: "/api/llm-provider-api-keys",
      payload: {
        name: "Original Name",
        provider: "bedrock",
        apiKey: "sk-bedrock-create-empty-base-url-test",
        scope: "personal",
      },
    });
    expect(createResponse.statusCode).toBe(400);
    expect(createResponse.json().error.message).toContain(
      "base URL not configured",
    );
  });

  test("prevent setting empty base URL to API keys for providers that require it", async () => {
    const createResponse = await app.inject({
      method: "POST",
      url: "/api/llm-provider-api-keys",
      payload: {
        name: "Original Name",
        provider: "bedrock",
        apiKey: "sk-bedrock-update-empty-base-url-test",
        scope: "personal",
        baseUrl: "https://bedrock.us-east-1.amazonaws.com",
      },
    });
    const createdKey = createResponse.json();

    const updateResponse = await app.inject({
      method: "PATCH",
      url: `/api/llm-provider-api-keys/${createdKey.id}`,
      payload: {
        baseUrl: null,
      },
    });

    expect(updateResponse.statusCode).toBe(400);
    expect(updateResponse.json().error.message).toContain(
      "base URL not configured",
    );
  });

  test("should allow to set base URL for providers with optional API key", async () => {
    const createResponse = await app.inject({
      method: "POST",
      url: "/api/llm-provider-api-keys",
      payload: {
        name: "Original Name",
        provider: "ollama",
        scope: "personal",
      },
    });
    expect(createResponse.statusCode).toBe(200);
    const createdKey = createResponse.json();

    const updateResponse = await app.inject({
      method: "PATCH",
      url: `/api/llm-provider-api-keys/${createdKey.id}`,
      payload: {
        baseUrl: null,
      },
    });
    expect(updateResponse.statusCode).toBe(200);

    const updateResponse2 = await app.inject({
      method: "PATCH",
      url: `/api/llm-provider-api-keys/${createdKey.id}`,
      payload: {
        baseUrl: "http://localhost:11434/v1",
      },
    });
    expect(updateResponse2.statusCode).toBe(200);
  });
});

describe("LLM Provider API Keys Available Endpoint", () => {
  let app: FastifyInstanceWithZod;
  let organizationId: string;
  let user: User;

  beforeEach(async ({ makeOrganization, makeUser, makeMember }) => {
    vi.clearAllMocks();
    setupAdminApp();

    const organization = await makeOrganization();
    organizationId = organization.id;
    user = await makeUser();
    await makeMember(user.id, organizationId, { role: "admin" });

    app = await createApp(organizationId, user);
  });

  afterEach(async () => {
    await app.close();
  });

  test("should get available API keys for current user", async ({
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    const secret = await makeSecret();
    const createdKey = await makeLlmProviderApiKey(organizationId, secret.id, {
      provider: "openai",
      scope: "personal",
      userId: user.id,
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/llm-provider-api-keys/available",
    });

    expect(response.statusCode).toBe(200);
    const availableKeys = response.json();
    expect(Array.isArray(availableKeys)).toBe(true);
    expect(
      availableKeys.some((k: { id: string }) => k.id === createdKey.id),
    ).toBe(true);
  });

  test("should filter available API keys by provider", async ({
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    const secret = await makeSecret();
    await makeLlmProviderApiKey(organizationId, secret.id, {
      provider: "openai",
      scope: "personal",
      userId: user.id,
    });

    // Filter by anthropic - should not include the openai key
    const response = await app.inject({
      method: "GET",
      url: "/api/llm-provider-api-keys/available?provider=anthropic",
    });

    expect(response.statusCode).toBe(200);
    const availableKeys = response.json();
    expect(
      availableKeys.every(
        (k: { provider: string }) => k.provider === "anthropic",
      ),
    ).toBe(true);
  });
});

describe("LLM Provider API Keys Team Scope", () => {
  let app: FastifyInstanceWithZod;
  let organizationId: string;
  let user: User;

  beforeEach(async ({ makeOrganization, makeUser, makeMember }) => {
    vi.clearAllMocks();
    setupAdminApp();

    const organization = await makeOrganization();
    organizationId = organization.id;
    user = await makeUser();
    await makeMember(user.id, organizationId, { role: "admin" });

    app = await createApp(organizationId, user);
  });

  afterEach(async () => {
    await app.close();
  });

  test("should create a team-scoped LLM provider API key", async ({
    makeTeam,
    makeTeamMember,
  }) => {
    const team = await makeTeam(organizationId, user.id);
    await makeTeamMember(team.id, user.id);

    const response = await app.inject({
      method: "POST",
      url: "/api/llm-provider-api-keys",
      payload: {
        name: "Team Test Key",
        provider: "openai",
        apiKey: "sk-openai-team-test-key",
        scope: "team",
        teamId: team.id,
      },
    });

    expect(response.statusCode).toBe(200);
    const apiKey = response.json();
    expect(apiKey.scope).toBe("team");
    expect(apiKey.teamId).toBe(team.id);
  });

  test("should require teamId for team-scoped LLM provider API keys", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/llm-provider-api-keys",
      payload: {
        name: "Team Key Without TeamId",
        provider: "anthropic",
        apiKey: "sk-ant-no-team-id",
        scope: "team",
      },
    });

    expect(response.statusCode).toBe(400);
  });

  test("prevents deleting an API key used for embedding", async () => {
    const createResponse = await app.inject({
      method: "POST",
      url: "/api/llm-provider-api-keys",
      payload: {
        name: "Embedding Delete Protection Key",
        provider: "openai",
        apiKey: "sk-openai-embedding-delete-protection-test",
        scope: "org",
      },
    });
    expect(createResponse.statusCode).toBe(200);
    const createdKey = createResponse.json();

    const knowledgeResponse = await app.inject({
      method: "PATCH",
      url: "/api/organization/knowledge-settings",
      payload: {
        embeddingChatApiKeyId: createdKey.id,
      },
    });
    expect(knowledgeResponse.statusCode).toBe(200);

    const deleteResponse = await app.inject({
      method: "DELETE",
      url: `/api/llm-provider-api-keys/${createdKey.id}`,
    });

    expect(deleteResponse.statusCode).toBe(400);
    expect(deleteResponse.json().error.message).toContain("embedding");
    expect(deleteResponse.json().error.message).toContain(
      "Remove it from Settings > Knowledge before deleting",
    );
  });

  test("prevents deleting an API key used for reranking", async () => {
    const createResponse = await app.inject({
      method: "POST",
      url: "/api/llm-provider-api-keys",
      payload: {
        name: "Reranker Delete Protection Key",
        provider: "openai",
        apiKey: "sk-openai-reranker-delete-protection-test",
        scope: "org",
      },
    });
    expect(createResponse.statusCode).toBe(200);
    const createdKey = createResponse.json();

    const knowledgeResponse = await app.inject({
      method: "PATCH",
      url: "/api/organization/knowledge-settings",
      payload: {
        rerankerChatApiKeyId: createdKey.id,
      },
    });
    expect(knowledgeResponse.statusCode).toBe(200);

    const deleteResponse = await app.inject({
      method: "DELETE",
      url: `/api/llm-provider-api-keys/${createdKey.id}`,
    });

    expect(deleteResponse.statusCode).toBe(400);
    expect(deleteResponse.json().error.message).toContain("reranking");
    expect(deleteResponse.json().error.message).toContain(
      "Remove it from Settings > Knowledge before deleting",
    );
  });
});

describe("LLM Provider API Keys Scope Update", () => {
  let app: FastifyInstanceWithZod;
  let organizationId: string;
  let user: User;

  beforeEach(async ({ makeOrganization, makeUser, makeMember }) => {
    vi.clearAllMocks();
    setupAdminApp();

    const organization = await makeOrganization();
    organizationId = organization.id;
    user = await makeUser();
    await makeMember(user.id, organizationId, { role: "admin" });

    app = await createApp(organizationId, user);
  });

  afterEach(async () => {
    await app.close();
  });

  test("should update scope from personal to org", async () => {
    const createResponse = await app.inject({
      method: "POST",
      url: "/api/llm-provider-api-keys",
      payload: {
        name: "Scope Update Test Key",
        provider: "anthropic",
        apiKey: "sk-ant-scope-update-test",
        scope: "personal",
      },
    });
    const createdKey = createResponse.json();

    const updateResponse = await app.inject({
      method: "PATCH",
      url: `/api/llm-provider-api-keys/${createdKey.id}`,
      payload: {
        scope: "org",
      },
    });

    expect(updateResponse.statusCode).toBe(200);
    const updatedKey = updateResponse.json();
    expect(updatedKey.scope).toBe("org");
    expect(updatedKey.userId).toBeNull();
  });
});

describe("LLM Provider API Keys Access Control", () => {
  let app: FastifyInstanceWithZod;
  let organizationId: string;
  let memberUser: User;

  beforeEach(async ({ makeOrganization, makeUser, makeMember }) => {
    vi.clearAllMocks();
    setupMemberApp();

    const organization = await makeOrganization();
    organizationId = organization.id;
    memberUser = await makeUser();
    await makeMember(memberUser.id, organizationId, { role: "member" });

    app = await createApp(organizationId, memberUser);
  });

  afterEach(async () => {
    await app.close();
  });

  test("member should be able to read LLM provider API keys", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/llm-provider-api-keys",
    });

    expect(response.statusCode).toBe(200);
  });

  test("member should not be able to create org-scoped LLM provider API keys", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/llm-provider-api-keys",
      payload: {
        name: "Unauthorized Key",
        provider: "anthropic",
        apiKey: "sk-ant-unauthorized",
        scope: "org",
      },
    });

    expect(response.statusCode).toBe(403);
  });
});
