import { providerDisplayNames } from "@archestra/shared";
import { vi } from "vitest";
import LlmProviderApiKeyModel from "@/models/llm-provider-api-key";
import LlmProviderApiKeyModelLinkModel from "@/models/llm-provider-api-key-model";
import ModelModel from "@/models/model";
import OrganizationModel from "@/models/organization";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";
import { ApiError } from "@/types";

// Mock the Vertex AI check
vi.mock("@/clients/gemini-client", () => ({
  isVertexAiEnabled: vi.fn(),
}));

vi.mock("@/clients/anthropic-workload-identity", () => ({
  anthropicWorkloadIdentity: {
    isEnabled: vi.fn(() => false),
  },
}));

vi.mock("@/clients/azure-openai-credentials", () => ({
  isAnthropicAzureFoundryEntraIdEnabled: vi.fn(() => false),
  isAzureOpenAiEntraIdEnabled: vi.fn(),
  getAzureAiFoundryBearerTokenProvider: vi.fn(),
  getAzureOpenAiBearerTokenProvider: vi.fn(),
}));

// Mock auth for permission checks
vi.mock("@/auth");

// Mock testProviderApiKey to avoid external calls
vi.mock("@/routes/chat/model-fetchers/registry", () => ({
  testProviderApiKey: vi.fn(async () => undefined),
}));

// Mock secrets-manager to use real DB-backed SecretModel for FK integrity
vi.mock("@/secrets-manager", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/secrets-manager")>();
  const { default: SecretModel } = await import("@/models/secret");
  return {
    ...actual,
    isByosEnabled: vi.fn().mockReturnValue(false),
    // The real getSecretValueForLlmProviderApiKey runs on top of this mocked
    // manager, so getSecret must return the (plaintext) DB row for routes that
    // inspect the stored credential (PATCH scope checks, reconnect).
    secretManager: vi.fn().mockReturnValue({
      createSecret: vi
        .fn()
        .mockImplementation(
          async (secret: Record<string, unknown>, name: string) =>
            SecretModel.create({ name, secret }),
        ),
      getSecret: vi
        .fn()
        .mockImplementation(async (id: string) => SecretModel.findById(id)),
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
import { anthropicWorkloadIdentity } from "@/clients/anthropic-workload-identity";
import { isAzureOpenAiEntraIdEnabled } from "@/clients/azure-openai-credentials";
import { isVertexAiEnabled } from "@/clients/gemini-client";
import { testProviderApiKey } from "@/routes/chat/model-fetchers/registry";
import { encodeOpenAiCodexCredential } from "@/services/openai-codex-credentials";
import { encodeXaiSubscriptionCredential } from "@/services/xai-subscription-credentials";
import { validateProviderAllowed } from "./llm-provider-api-keys";

const mockAnthropicWifIsEnabled = vi.mocked(
  anthropicWorkloadIdentity.isEnabled,
);
const mockIsAzureOpenAiEntraIdEnabled = vi.mocked(isAzureOpenAiEntraIdEnabled);
const mockIsVertexAiEnabled = vi.mocked(isVertexAiEnabled);
const mockHasPermission = vi.mocked(hasPermission);
const mockUserHasPermission = vi.mocked(userHasPermission);
const mockTestProviderApiKey = vi.mocked(testProviderApiKey);

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
        bestModelId: model.id,
      },
    ]);
    expect(getBestModelsForApiKeysSpy).toHaveBeenCalledWith([apiKey.id]);
    expect(getBestModelSpy).not.toHaveBeenCalled();
  });

  test("includeKeyId carries subscription metadata for another user's SuperGrok key", async ({
    makeSecret,
    makeUser,
    makeLlmProviderApiKey,
  }) => {
    const owner = await makeUser();
    const secret = await makeSecret({
      secret: {
        apiKey: encodeXaiSubscriptionCredential({
          refreshToken: "owner-refresh-token",
          userId: "owner-x-user-id",
        }),
      },
    });
    const ownerKey = await makeLlmProviderApiKey(organizationId, secret.id, {
      provider: "xai",
      scope: "personal",
      userId: owner.id,
      name: "SuperGrok",
    });

    const response = await app.inject({
      method: "GET",
      url: `/api/llm-provider-api-keys/available?includeKeyId=${ownerKey.id}`,
    });

    expect(response.statusCode).toBe(200);
    const includedKey = response
      .json()
      .find((key: { id: string }) => key.id === ownerKey.id);
    // The viewer can't list the owner's personal key, but the included agent
    // key must say it is a SuperGrok credential so the chat/agent preflight
    // gates sending behind "connect your own account".
    expect(includedKey).toMatchObject({
      isAgentKey: true,
      subscriptionKind: "x-premium",
    });
  });

  test("includeKeyId reports no subscription kind for a plain xAI key", async ({
    makeSecret,
    makeUser,
    makeLlmProviderApiKey,
  }) => {
    const owner = await makeUser();
    const secret = await makeSecret({
      secret: { apiKey: "xai-plain-console-key" },
    });
    const ownerKey = await makeLlmProviderApiKey(organizationId, secret.id, {
      provider: "xai",
      scope: "personal",
      userId: owner.id,
      name: "Owner xAI Key",
    });

    const response = await app.inject({
      method: "GET",
      url: `/api/llm-provider-api-keys/available?includeKeyId=${ownerKey.id}`,
    });

    expect(response.statusCode).toBe(200);
    const includedKey = response
      .json()
      .find((key: { id: string }) => key.id === ownerKey.id);
    expect(includedKey).toMatchObject({ isAgentKey: true });
    expect(includedKey.subscriptionKind ?? null).toBeNull();
  });
});

describe("LLM Provider API Keys CRUD", () => {
  let app: FastifyInstanceWithZod;
  let organizationId: string;
  let user: User;

  beforeEach(async ({ makeOrganization, makeUser, makeMember }) => {
    vi.clearAllMocks();
    setupAdminApp();
    mockIsAzureOpenAiEntraIdEnabled.mockReturnValue(false);
    mockAnthropicWifIsEnabled.mockReturnValue(false);

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

  test("tests API key creation against inference URL when provided", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/llm-provider-api-keys",
      payload: {
        name: "Inference URL Create Test",
        provider: "openai",
        apiKey: "sk-openai-inference-url-create-test",
        scope: "personal",
        baseUrl: "https://discovery.example.com/v1",
        inferenceBaseUrl: "https://runtime.example.com/v1",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(mockTestProviderApiKey).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "openai",
        apiKey: "sk-openai-inference-url-create-test",
        baseUrl: "https://runtime.example.com/v1",
        extraHeaders: undefined,
      }),
    );
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

  test("rejects non-personal scope for per-user providers (github-copilot)", async () => {
    for (const scope of ["org", "team"] as const) {
      const response = await app.inject({
        method: "POST",
        url: "/api/llm-provider-api-keys",
        payload: {
          name: `Shared Copilot ${scope}`,
          provider: "github-copilot",
          apiKey: "gho_shared_token",
          scope,
          ...(scope === "team"
            ? { teamId: "00000000-0000-0000-0000-000000000000" }
            : {}),
        },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().error.message).toContain("per-user");
    }
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

  test("returns subscription metadata for a single key fetched by ID", async ({
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    // The edit dialog's URL-param path (?edit=<id>) resolves through this
    // route; without the derived kind an F5 mid-edit would reopen an
    // SuperGrok key on the API-key tab with no connected card.
    const secret = await makeSecret({
      secret: {
        apiKey: encodeXaiSubscriptionCredential({
          refreshToken: "rt-get-by-id",
          userId: "x-user-id",
        }),
      },
    });
    const key = await makeLlmProviderApiKey(organizationId, secret.id, {
      provider: "xai",
      scope: "personal",
      userId: user.id,
      name: "SuperGrok",
    });

    const response = await app.inject({
      method: "GET",
      url: `/api/llm-provider-api-keys/${key.id}`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      id: key.id,
      subscriptionKind: "x-premium",
    });
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

  test("refuses to delete a system API key", async () => {
    const systemKey = await LlmProviderApiKeyModel.createSystemKey({
      organizationId,
      name: "System Gemini",
      provider: "gemini",
    });

    const response = await app.inject({
      method: "DELETE",
      url: `/api/llm-provider-api-keys/${systemKey.id}`,
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.message).toBe(
      "System API keys cannot be deleted",
    );
    expect(await LlmProviderApiKeyModel.findById(systemKey.id)).not.toBeNull();
  });

  test("refuses to delete a key backing the organization's OCR configuration", async () => {
    const createResponse = await app.inject({
      method: "POST",
      url: "/api/llm-provider-api-keys",
      payload: {
        name: "OCR Key",
        provider: "anthropic",
        apiKey: "sk-ant-ocr-test",
        scope: "personal",
      },
    });
    const createdKey = createResponse.json();
    await OrganizationModel.patch(organizationId, {
      ocrChatApiKeyId: createdKey.id,
      ocrModel: "claude-sonnet-5",
    });

    const deleteResponse = await app.inject({
      method: "DELETE",
      url: `/api/llm-provider-api-keys/${createdKey.id}`,
    });

    expect(deleteResponse.statusCode).toBe(400);
    expect(deleteResponse.json().error.message).toContain("OCR");
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

  test("creates a Bedrock key without a custom endpoint", async () => {
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
    expect(createResponse.statusCode).toBe(200);
    expect(mockTestProviderApiKey).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "bedrock",
        baseUrl: undefined,
      }),
    );
  });

  test("clears a Bedrock custom endpoint to restore the regional default", async () => {
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

    expect(updateResponse.statusCode).toBe(200);
    expect(mockTestProviderApiKey).toHaveBeenLastCalledWith(
      expect.objectContaining({
        provider: "bedrock",
        baseUrl: null,
      }),
    );
  });

  test("re-tests existing API key when inference URL changes", async () => {
    const createResponse = await app.inject({
      method: "POST",
      url: "/api/llm-provider-api-keys",
      payload: {
        name: "Inference URL Update Test",
        provider: "openai",
        apiKey: "sk-openai-inference-url-update-test",
        scope: "personal",
        baseUrl: "https://discovery.example.com/v1",
      },
    });
    expect(createResponse.statusCode).toBe(200);
    const createdKey = createResponse.json();
    mockTestProviderApiKey.mockClear();

    const updateResponse = await app.inject({
      method: "PATCH",
      url: `/api/llm-provider-api-keys/${createdKey.id}`,
      payload: {
        inferenceBaseUrl: "https://runtime.example.com/v1",
      },
    });

    expect(updateResponse.statusCode).toBe(200);
    expect(mockTestProviderApiKey).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "openai",
        apiKey: "sk-openai-inference-url-update-test",
        baseUrl: "https://runtime.example.com/v1",
        extraHeaders: null,
      }),
    );
  });

  test("re-tests existing API key against stored inference URL when only base URL changes", async () => {
    const createResponse = await app.inject({
      method: "POST",
      url: "/api/llm-provider-api-keys",
      payload: {
        name: "Base URL Update With Stored Inference URL Test",
        provider: "openai",
        apiKey: "sk-openai-base-url-update-test",
        scope: "personal",
        baseUrl: "https://discovery.example.com/v1",
        inferenceBaseUrl: "https://runtime.example.com/v1",
      },
    });
    expect(createResponse.statusCode).toBe(200);
    const createdKey = createResponse.json();
    mockTestProviderApiKey.mockClear();

    const updateResponse = await app.inject({
      method: "PATCH",
      url: `/api/llm-provider-api-keys/${createdKey.id}`,
      payload: {
        baseUrl: "https://new-discovery.example.com/v1",
      },
    });

    expect(updateResponse.statusCode).toBe(200);
    expect(mockTestProviderApiKey).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "openai",
        apiKey: "sk-openai-base-url-update-test",
        baseUrl: "https://runtime.example.com/v1",
        extraHeaders: null,
      }),
    );
  });

  test("re-tests existing API key against updated base URL when inference URL is cleared", async () => {
    const createResponse = await app.inject({
      method: "POST",
      url: "/api/llm-provider-api-keys",
      payload: {
        name: "Inference URL Clear Test",
        provider: "openai",
        apiKey: "sk-openai-inference-url-clear-test",
        scope: "personal",
        baseUrl: "https://discovery.example.com/v1",
        inferenceBaseUrl: "https://runtime.example.com/v1",
      },
    });
    expect(createResponse.statusCode).toBe(200);
    const createdKey = createResponse.json();
    mockTestProviderApiKey.mockClear();

    const updateResponse = await app.inject({
      method: "PATCH",
      url: `/api/llm-provider-api-keys/${createdKey.id}`,
      payload: {
        baseUrl: "https://new-runtime.example.com/v1",
        inferenceBaseUrl: null,
      },
    });

    expect(updateResponse.statusCode).toBe(200);
    expect(mockTestProviderApiKey).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "openai",
        apiKey: "sk-openai-inference-url-clear-test",
        baseUrl: "https://new-runtime.example.com/v1",
        extraHeaders: null,
      }),
    );
  });

  test("tests new API key value against inference URL when both change", async () => {
    const createResponse = await app.inject({
      method: "POST",
      url: "/api/llm-provider-api-keys",
      payload: {
        name: "Inference URL Update With Key Test",
        provider: "openai",
        apiKey: "sk-openai-original-key",
        scope: "personal",
        baseUrl: "https://discovery.example.com/v1",
      },
    });
    expect(createResponse.statusCode).toBe(200);
    const createdKey = createResponse.json();
    mockTestProviderApiKey.mockClear();

    const updateResponse = await app.inject({
      method: "PATCH",
      url: `/api/llm-provider-api-keys/${createdKey.id}`,
      payload: {
        apiKey: "sk-openai-updated-key",
        inferenceBaseUrl: "https://runtime.example.com/v1",
      },
    });

    expect(updateResponse.statusCode).toBe(200);
    expect(mockTestProviderApiKey).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "openai",
        apiKey: "sk-openai-updated-key",
        baseUrl: "https://runtime.example.com/v1",
        extraHeaders: null,
      }),
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

  test("surfaces a Docker localhost hint when keyless Ollama creation can't connect", async () => {
    mockTestProviderApiKey.mockRejectedValueOnce(new Error("fetch failed"));

    const response = await app.inject({
      method: "POST",
      url: "/api/llm-provider-api-keys",
      payload: {
        name: "Ollama Local",
        provider: "ollama",
        scope: "personal",
        baseUrl: "http://localhost:11434/v1",
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.message).toContain(
      "http://host.docker.internal:11434/v1",
    );
    // Connectivity was tested without an API key.
    expect(mockTestProviderApiKey).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "ollama",
        apiKey: "",
        baseUrl: "http://localhost:11434/v1",
        extraHeaders: undefined,
      }),
    );
  });

  test("uses the provider display name in keyless connection errors", async () => {
    mockTestProviderApiKey.mockRejectedValueOnce(new Error("fetch failed"));

    const response = await app.inject({
      method: "POST",
      url: "/api/llm-provider-api-keys",
      payload: {
        name: "vLLM Local",
        provider: "vllm",
        scope: "personal",
        baseUrl: "http://192.168.1.50:8000/v1",
      },
    });

    expect(response.statusCode).toBe(400);
    // Derived, not hardcoded: the label is the entry's display name, which
    // names the OpenAI-compatible path rather than any one engine.
    expect(response.json().error.message).toContain(
      `Failed to connect to ${providerDisplayNames.vllm}: fetch failed`,
    );
  });

  test("reports a network problem (not an invalid key) when the provider is unreachable", async () => {
    mockTestProviderApiKey.mockRejectedValueOnce(new Error("fetch failed"));

    const response = await app.inject({
      method: "POST",
      url: "/api/llm-provider-api-keys",
      payload: {
        name: "Unreachable Anthropic",
        provider: "anthropic",
        apiKey: "sk-ant-unreachable-test",
        scope: "personal",
      },
    });

    expect(response.statusCode).toBe(400);
    const message = response.json().error.message;
    // The configured default URL is env-dependent, so assert its presence in
    // the label without pinning the value.
    expect(message).toMatch(
      /^Could not reach Anthropic \(\S+\) to validate the API key: fetch failed/,
    );
    expect(message).not.toContain("Invalid API key");
  });

  test("reports an invalid key (not a connection failure) when the provider rejects it", async () => {
    mockTestProviderApiKey.mockRejectedValueOnce(
      new Error("Failed to fetch Anthropic models: 401"),
    );

    const response = await app.inject({
      method: "POST",
      url: "/api/llm-provider-api-keys",
      payload: {
        name: "Rejected Anthropic",
        provider: "anthropic",
        apiKey: "sk-ant-rejected-test",
        scope: "personal",
      },
    });

    expect(response.statusCode).toBe(400);
    const message = response.json().error.message;
    expect(message).toBe("Invalid API key: HTTP 401");
    expect(message).not.toContain("Could not reach");
  });

  test("keeps the Docker localhost hint on keyed-provider connection failures", async () => {
    mockTestProviderApiKey.mockRejectedValueOnce(new Error("fetch failed"));

    const response = await app.inject({
      method: "POST",
      url: "/api/llm-provider-api-keys",
      payload: {
        name: "Local OpenAI-compatible",
        provider: "openai",
        apiKey: "sk-local-test",
        scope: "personal",
        baseUrl: "http://localhost:8080/v1",
      },
    });

    expect(response.statusCode).toBe(400);
    const message = response.json().error.message;
    expect(message).toContain(
      "Could not reach OpenAI (http://localhost:8080/v1)",
    );
    expect(message).toContain("http://host.docker.internal:8080/v1");
  });

  test("falls back to the invalid-key error when the validation message has no HTTP status", async () => {
    mockTestProviderApiKey.mockRejectedValueOnce(
      new Error("Models list is empty"),
    );

    const response = await app.inject({
      method: "POST",
      url: "/api/llm-provider-api-keys",
      payload: {
        name: "Empty Models Anthropic",
        provider: "anthropic",
        apiKey: "sk-ant-empty-models-test",
        scope: "personal",
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.message).toBe(
      "Invalid API key: Models list is empty",
    );
  });

  test("points at the base URL (not the key or a temporary issue) on a 404 validation response", async () => {
    mockTestProviderApiKey.mockRejectedValueOnce(
      new Error("Failed to fetch Anthropic models: 404"),
    );

    const response = await app.inject({
      method: "POST",
      url: "/api/llm-provider-api-keys",
      payload: {
        name: "Wrong Path Anthropic",
        provider: "anthropic",
        apiKey: "sk-ant-wrong-path-test",
        scope: "personal",
        baseUrl: "https://anthropic.example.com/extra",
      },
    });

    expect(response.statusCode).toBe(400);
    const message = response.json().error.message;
    expect(message).toContain(
      "Anthropic (https://anthropic.example.com/extra) returned an error while validating the API key: HTTP 404",
    );
    expect(message).toContain("verify it");
    expect(message).not.toContain("temporary provider issue");
    expect(message).not.toContain("Invalid API key");
  });

  test("treats a non-JSON response body as a wrong endpoint, not an invalid key", async () => {
    mockTestProviderApiKey.mockRejectedValueOnce(
      new Error("Unexpected token '<', \"<html>\" is not valid JSON"),
    );

    const response = await app.inject({
      method: "POST",
      url: "/api/llm-provider-api-keys",
      payload: {
        name: "HTML Anthropic",
        provider: "anthropic",
        apiKey: "sk-ant-html-test",
        scope: "personal",
      },
    });

    expect(response.statusCode).toBe(400);
    const message = response.json().error.message;
    expect(message).toContain("returned an error while validating the API key");
    expect(message).toContain("does not look like the provider's API");
    expect(message).not.toContain("Invalid API key");
  });

  test("reports a provider-side error (not an invalid key) on a 429/5xx validation response", async () => {
    mockTestProviderApiKey.mockRejectedValueOnce(
      new Error("Failed to fetch Anthropic models: 429"),
    );

    const response = await app.inject({
      method: "POST",
      url: "/api/llm-provider-api-keys",
      payload: {
        name: "Throttled Anthropic",
        provider: "anthropic",
        apiKey: "sk-ant-throttled-test",
        scope: "personal",
        baseUrl: "https://anthropic.example.com",
      },
    });

    expect(response.statusCode).toBe(400);
    const message = response.json().error.message;
    expect(message).toContain(
      "Anthropic (https://anthropic.example.com) returned an error while validating the API key: HTTP 429",
    );
    expect(message).toContain("temporary provider issue");
    expect(message).not.toContain("Invalid API key");
    expect(message).not.toContain("Could not reach");
  });

  test("treats an empty Ollama model list as a reachable server (keyless create succeeds)", async () => {
    mockTestProviderApiKey.mockRejectedValueOnce(
      new Error("Models list is empty"),
    );

    const response = await app.inject({
      method: "POST",
      url: "/api/llm-provider-api-keys",
      payload: {
        name: "Ollama No Models",
        provider: "ollama",
        scope: "personal",
        baseUrl: "http://localhost:11434/v1",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ name: "Ollama No Models" });
  });

  test("allows Azure provider keys without API key when Entra ID is enabled", async () => {
    mockIsAzureOpenAiEntraIdEnabled.mockReturnValue(true);

    const createResponse = await app.inject({
      method: "POST",
      url: "/api/llm-provider-api-keys",
      payload: {
        name: "Azure Resource",
        provider: "azure",
        scope: "personal",
        baseUrl: "https://my-resource.openai.azure.com/openai",
      },
    });

    expect(createResponse.statusCode).toBe(200);
    expect(createResponse.json()).toMatchObject({
      name: "Azure Resource",
      provider: "azure",
      secretId: null,
      baseUrl: "https://my-resource.openai.azure.com/openai",
    });
    expect(mockTestProviderApiKey).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "azure",
        apiKey: "",
        baseUrl: "https://my-resource.openai.azure.com/openai",
        extraHeaders: undefined,
      }),
    );
  });

  test("re-tests keyless Azure Entra provider key when inference URL changes", async () => {
    mockIsAzureOpenAiEntraIdEnabled.mockReturnValue(true);

    const createResponse = await app.inject({
      method: "POST",
      url: "/api/llm-provider-api-keys",
      payload: {
        name: "Azure Split Endpoint",
        provider: "azure",
        scope: "personal",
        baseUrl: "https://discovery.example.com/openai",
      },
    });
    expect(createResponse.statusCode).toBe(200);
    const createdKey = createResponse.json();
    mockTestProviderApiKey.mockClear();

    const updateResponse = await app.inject({
      method: "PATCH",
      url: `/api/llm-provider-api-keys/${createdKey.id}`,
      payload: {
        inferenceBaseUrl: "https://runtime.example.com/openai/v1",
      },
    });

    expect(updateResponse.statusCode).toBe(200);
    expect(mockTestProviderApiKey).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "azure",
        apiKey: "",
        baseUrl: "https://runtime.example.com/openai/v1",
        extraHeaders: null,
      }),
    );
  });

  test("creates a keyless Anthropic key when Workload Identity Federation is configured", async () => {
    mockAnthropicWifIsEnabled.mockReturnValue(true);

    const createResponse = await app.inject({
      method: "POST",
      url: "/api/llm-provider-api-keys",
      payload: {
        name: "Anthropic WIF",
        provider: "anthropic",
        scope: "personal",
      },
    });

    expect(createResponse.statusCode).toBe(200);
    expect(createResponse.json()).toMatchObject({
      name: "Anthropic WIF",
      provider: "anthropic",
      secretId: null,
    });
    // Keyless create must still exercise the WIF token exchange + model listing.
    expect(mockTestProviderApiKey).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "anthropic",
        apiKey: "",
        baseUrl: undefined,
        extraHeaders: undefined,
      }),
    );
  });

  test("rejects keyless Anthropic keys when Workload Identity Federation is not configured", async () => {
    const createResponse = await app.inject({
      method: "POST",
      url: "/api/llm-provider-api-keys",
      payload: {
        name: "Anthropic Keyless",
        provider: "anthropic",
        scope: "personal",
      },
    });

    expect(createResponse.statusCode).toBe(400);
  });

  test("re-tests keyless Anthropic WIF key when runtime settings change", async () => {
    mockAnthropicWifIsEnabled.mockReturnValue(true);

    const createResponse = await app.inject({
      method: "POST",
      url: "/api/llm-provider-api-keys",
      payload: {
        name: "Anthropic WIF",
        provider: "anthropic",
        scope: "personal",
      },
    });
    expect(createResponse.statusCode).toBe(200);
    const createdKey = createResponse.json();
    mockTestProviderApiKey.mockClear();

    const updateResponse = await app.inject({
      method: "PATCH",
      url: `/api/llm-provider-api-keys/${createdKey.id}`,
      payload: {
        baseUrl: "https://api.anthropic.com",
      },
    });

    expect(updateResponse.statusCode).toBe(200);
    expect(mockTestProviderApiKey).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "anthropic",
        apiKey: "",
        baseUrl: "https://api.anthropic.com",
        extraHeaders: null,
      }),
    );
  });

  test("tests keyless Azure Entra creation against discovery and inference URLs", async () => {
    mockIsAzureOpenAiEntraIdEnabled.mockReturnValue(true);

    const createResponse = await app.inject({
      method: "POST",
      url: "/api/llm-provider-api-keys",
      payload: {
        name: "Azure Split Endpoint Create",
        provider: "azure",
        scope: "personal",
        baseUrl: "https://discovery.example.com/openai",
        inferenceBaseUrl: "https://runtime.example.com/openai/v1",
      },
    });

    expect(createResponse.statusCode).toBe(200);
    expect(mockTestProviderApiKey).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "azure",
        apiKey: "",
        baseUrl: "https://discovery.example.com/openai",
        extraHeaders: undefined,
      }),
    );
    expect(mockTestProviderApiKey).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "azure",
        apiKey: "",
        baseUrl: "https://runtime.example.com/openai/v1",
        extraHeaders: undefined,
      }),
    );
  });

  test("rejects keyless Azure provider keys when Entra ID validation cannot discover models", async () => {
    mockIsAzureOpenAiEntraIdEnabled.mockReturnValue(true);
    mockTestProviderApiKey.mockRejectedValueOnce(
      new Error("Models list is empty"),
    );

    const createResponse = await app.inject({
      method: "POST",
      url: "/api/llm-provider-api-keys",
      payload: {
        name: "Azure Resource",
        provider: "azure",
        scope: "personal",
        baseUrl: "https://my-resource.openai.azure.com/openai",
      },
    });

    expect(createResponse.statusCode).toBe(400);
    expect(createResponse.json().error.message).toContain(
      "Azure Entra ID validation failed: Archestra could not discover any Azure model deployments.",
    );
    expect(createResponse.json().error.message).toContain(
      "Provider error: Models list is empty",
    );

    const listResponse = await app.inject({
      method: "GET",
      url: "/api/llm-provider-api-keys",
    });
    expect(listResponse.statusCode).toBe(200);
    expect(listResponse.json()).toEqual([]);
  });

  test("rejects Azure provider keys without API key when Entra ID is disabled", async () => {
    mockIsAzureOpenAiEntraIdEnabled.mockReturnValue(false);

    const createResponse = await app.inject({
      method: "POST",
      url: "/api/llm-provider-api-keys",
      payload: {
        name: "Azure Resource",
        provider: "azure",
        scope: "personal",
        baseUrl: "https://my-resource.openai.azure.com/openai",
      },
    });

    expect(createResponse.statusCode).toBe(400);
    expect(createResponse.json().error.message).toContain(
      "Either apiKey, both vaultSecretPath and vaultSecretKey, or AWS SigV4 credentials (Bedrock only) must be provided",
    );
  });
});

describe("LLM Provider API Keys — personal scope is self-service", () => {
  let app: FastifyInstanceWithZod;
  let organizationId: string;
  let user: User;

  // A "basic user": no llmProviderApiKey:create / :admin, no team:create.
  beforeEach(async ({ makeOrganization, makeUser, makeMember }) => {
    vi.clearAllMocks();
    setupMemberApp();
    mockIsAzureOpenAiEntraIdEnabled.mockReturnValue(false);

    const organization = await makeOrganization();
    organizationId = organization.id;
    user = await makeUser();
    await makeMember(user.id, organizationId, { role: "member" });

    app = await createApp(organizationId, user);
  });

  afterEach(async () => {
    await app.close();
  });

  test("a basic user can create a personal key (e.g. connect GitHub Copilot)", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/llm-provider-api-keys",
      payload: {
        name: "GitHub Copilot",
        provider: "github-copilot",
        apiKey: "gho_my_token",
        scope: "personal",
      },
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().scope).toBe("personal");
  });

  test("a basic user can create a personal key for any provider", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/llm-provider-api-keys",
      payload: {
        name: "My OpenAI",
        provider: "openai",
        apiKey: "sk-my-openai-key",
        scope: "personal",
      },
    });

    expect(response.statusCode, response.body).toBe(200);
  });

  test("a basic user cannot create an org-scoped key", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/llm-provider-api-keys",
      payload: {
        name: "Org Key",
        provider: "anthropic",
        apiKey: "sk-ant-org-key",
        scope: "org",
      },
    });

    expect(response.statusCode).toBe(403);
  });

  test("a basic team member cannot create a team-scoped key without create permission", async ({
    makeTeam,
    makeTeamMember,
  }) => {
    const team = await makeTeam(organizationId, user.id);
    await makeTeamMember(team.id, user.id);

    const response = await app.inject({
      method: "POST",
      url: "/api/llm-provider-api-keys",
      payload: {
        name: "Team Key",
        provider: "anthropic",
        apiKey: "sk-ant-team-key",
        scope: "team",
        teamId: team.id,
      },
    });

    expect(response.statusCode, response.body).toBe(403);
    expect(response.json().error.message).toContain("create");
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

  test("rejects a ChatGPT-subscription credential pasted into an org key without a scope change", async () => {
    const createResponse = await app.inject({
      method: "POST",
      url: "/api/llm-provider-api-keys",
      payload: {
        name: "Org OpenAI Key",
        provider: "openai",
        apiKey: "sk-openai-org-key",
        scope: "org",
      },
    });
    expect(createResponse.statusCode).toBe(200);
    const createdKey = createResponse.json();

    // Only the secret value changes — scope/team stay org — so this must be
    // classified by the new value, or one person's subscription becomes the
    // shared org credential.
    const updateResponse = await app.inject({
      method: "PATCH",
      url: `/api/llm-provider-api-keys/${createdKey.id}`,
      payload: {
        apiKey: encodeOpenAiCodexCredential({
          refreshToken: "refresh-token",
          accountId: "account-id",
        }),
      },
    });

    expect(updateResponse.statusCode).toBe(400);
    expect(updateResponse.json().error.message).toContain("per-user");
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

describe("POST /api/llm-provider-api-keys/:id/reconnect", () => {
  let app: FastifyInstanceWithZod;
  let organizationId: string;
  let memberUser: User;

  const storedCredential = encodeOpenAiCodexCredential({
    refreshToken: "rt-stored-dead",
    accountId: "acc-1",
  });
  const freshCredential = encodeOpenAiCodexCredential({
    refreshToken: "rt-fresh",
    accountId: "acc-1",
  });

  // Deliberately a plain member with NO llmProviderApiKey permissions: the
  // whole point of the route is that reconnecting your own personal
  // subscription key is self-service, like connecting it was.
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

  test("rotates the caller's own personal subscription key in place", async ({
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    const secret = await makeSecret({ secret: { apiKey: storedCredential } });
    const key = await makeLlmProviderApiKey(organizationId, secret.id, {
      provider: "openai",
      scope: "personal",
      userId: memberUser.id,
    });

    const response = await app.inject({
      method: "POST",
      url: `/api/llm-provider-api-keys/${key.id}/reconnect`,
      payload: { apiKey: freshCredential },
    });

    expect(response.statusCode).toBe(200);
    expect(mockTestProviderApiKey).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "openai", apiKey: freshCredential }),
    );
    const { secretManager } = await import("@/secrets-manager");
    expect(secretManager().updateSecret).toHaveBeenCalledWith(secret.id, {
      apiKey: freshCredential,
    });
  });

  test("also reconnects provider-level subscription keys (GitHub Copilot)", async ({
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    const secret = await makeSecret({ secret: { apiKey: "gho_old" } });
    const key = await makeLlmProviderApiKey(organizationId, secret.id, {
      provider: "github-copilot",
      scope: "personal",
      userId: memberUser.id,
    });

    const response = await app.inject({
      method: "POST",
      url: `/api/llm-provider-api-keys/${key.id}/reconnect`,
      payload: { apiKey: "gho_fresh" },
    });

    expect(response.statusCode).toBe(200);
    const { secretManager } = await import("@/secrets-manager");
    expect(secretManager().updateSecret).toHaveBeenCalledWith(secret.id, {
      apiKey: "gho_fresh",
    });
  });

  test("404s for another user's personal key", async ({
    makeSecret,
    makeLlmProviderApiKey,
    makeUser,
  }) => {
    const otherUser = await makeUser();
    const secret = await makeSecret({ secret: { apiKey: storedCredential } });
    const key = await makeLlmProviderApiKey(organizationId, secret.id, {
      provider: "openai",
      scope: "personal",
      userId: otherUser.id,
    });

    const response = await app.inject({
      method: "POST",
      url: `/api/llm-provider-api-keys/${key.id}/reconnect`,
      payload: { apiKey: freshCredential },
    });

    expect(response.statusCode).toBe(404);
  });

  test("rejects shared keys", async ({ makeSecret, makeLlmProviderApiKey }) => {
    const secret = await makeSecret({ secret: { apiKey: "sk-org" } });
    const key = await makeLlmProviderApiKey(organizationId, secret.id, {
      provider: "openai",
      scope: "org",
    });

    const response = await app.inject({
      method: "POST",
      url: `/api/llm-provider-api-keys/${key.id}/reconnect`,
      payload: { apiKey: freshCredential },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.message).toContain("personal");
  });

  test("rejects a plain API key value — reconnect is not an edit bypass", async ({
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    const secret = await makeSecret({ secret: { apiKey: storedCredential } });
    const key = await makeLlmProviderApiKey(organizationId, secret.id, {
      provider: "openai",
      scope: "personal",
      userId: memberUser.id,
    });

    const response = await app.inject({
      method: "POST",
      url: `/api/llm-provider-api-keys/${key.id}/reconnect`,
      payload: { apiKey: "sk-plain-api-key" },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.message).toContain("subscription sign-in");
  });

  test("rejects when the stored secret is a plain API key", async ({
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    const secret = await makeSecret({ secret: { apiKey: "sk-plain-stored" } });
    const key = await makeLlmProviderApiKey(organizationId, secret.id, {
      provider: "openai",
      scope: "personal",
      userId: memberUser.id,
    });

    const response = await app.inject({
      method: "POST",
      url: `/api/llm-provider-api-keys/${key.id}/reconnect`,
      payload: { apiKey: freshCredential },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.message).toContain("plain API key");
  });

  test("rejects when the stored secret lives in a read-only BYOS Vault", async ({
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    const secret = await makeSecret({
      secret: { apiKey: "vault/data/llm#openai" },
      isByosVault: true,
    } as never);
    const key = await makeLlmProviderApiKey(organizationId, secret.id, {
      provider: "openai",
      scope: "personal",
      userId: memberUser.id,
    });

    const response = await app.inject({
      method: "POST",
      url: `/api/llm-provider-api-keys/${key.id}/reconnect`,
      payload: { apiKey: freshCredential },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.message).toContain("Vault");
  });
});

describe("LLM Provider API Keys — providers the organization turned off", () => {
  let app: FastifyInstanceWithZod;
  let organizationId: string;
  let user: User;

  beforeEach(async ({ makeOrganization, makeUser, makeMember }) => {
    vi.clearAllMocks();
    setupAdminApp();
    mockIsAzureOpenAiEntraIdEnabled.mockReturnValue(false);
    mockAnthropicWifIsEnabled.mockReturnValue(false);

    const organization = await makeOrganization();
    organizationId = organization.id;
    user = await makeUser();
    await makeMember(user.id, organizationId, { role: "admin" });

    app = await createApp(organizationId, user);
  });

  afterEach(async () => {
    await app.close();
  });

  const turnOffAnthropic = async (displayName?: string) => {
    const response = await app.inject({
      method: "PATCH",
      url: "/api/organization/integration-settings",
      payload: {
        modelProviderOverrides: {
          anthropic: { hidden: true, ...(displayName ? { displayName } : {}) },
        },
      },
    });
    expect(response.statusCode).toBe(200);
  };

  test("refuses to create a key for a turned-off provider", async () => {
    await turnOffAnthropic();

    const response = await app.inject({
      method: "POST",
      url: "/api/llm-provider-api-keys",
      payload: {
        name: "Blocked Key",
        provider: "anthropic",
        apiKey: "sk-ant-blocked",
        scope: "personal",
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.message).toContain("turned off");
  });

  test("names the turned-off provider the way the admin renamed it", async () => {
    await turnOffAnthropic("Anthropic (retired)");

    const response = await app.inject({
      method: "POST",
      url: "/api/llm-provider-api-keys",
      payload: {
        name: "Blocked Key",
        provider: "anthropic",
        apiKey: "sk-ant-blocked",
        scope: "personal",
      },
    });

    expect(response.json().error.message).toContain("Anthropic (retired)");
  });

  test("still allows providers left switched on", async () => {
    await turnOffAnthropic();

    const response = await app.inject({
      method: "POST",
      url: "/api/llm-provider-api-keys",
      payload: {
        name: "Allowed Key",
        provider: "openai",
        apiKey: "sk-openai-allowed",
        scope: "personal",
      },
    });

    expect(response.statusCode).toBe(200);
  });

  test("freezes an existing key once its provider is turned off, but keeps it deletable", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/llm-provider-api-keys",
      payload: {
        name: "Existing Key",
        provider: "anthropic",
        apiKey: "sk-ant-existing",
        scope: "personal",
      },
    });
    expect(created.statusCode).toBe(200);
    const keyId = created.json().id;

    await turnOffAnthropic();

    const update = await app.inject({
      method: "PATCH",
      url: `/api/llm-provider-api-keys/${keyId}`,
      payload: { name: "Renamed" },
    });
    expect(update.statusCode).toBe(400);

    const removal = await app.inject({
      method: "DELETE",
      url: `/api/llm-provider-api-keys/${keyId}`,
    });
    expect(removal.statusCode).toBe(200);
  });
});

describe("validation errors name the provider the way the organization does", () => {
  let app: FastifyInstanceWithZod;
  let organizationId: string;
  let user: User;

  beforeEach(async ({ makeOrganization, makeUser, makeMember }) => {
    vi.clearAllMocks();
    setupAdminApp();
    mockIsAzureOpenAiEntraIdEnabled.mockReturnValue(false);
    mockAnthropicWifIsEnabled.mockReturnValue(false);

    const organization = await makeOrganization();
    organizationId = organization.id;
    user = await makeUser();
    await makeMember(user.id, organizationId, { role: "admin" });
    app = await createApp(organizationId, user);
  });

  afterEach(async () => {
    await app.close();
  });

  const createOpenAiKey = () =>
    app.inject({
      method: "POST",
      url: "/api/llm-provider-api-keys",
      payload: {
        name: "Key",
        provider: "openai",
        apiKey: "sk-rejected",
        scope: "personal",
      },
    });

  test("uses the renamed provider and never its shipped name", async () => {
    await app.inject({
      method: "PATCH",
      url: "/api/organization/integration-settings",
      payload: {
        modelProviderOverrides: { openai: { displayName: "Northwind Models" } },
      },
    });
    mockTestProviderApiKey.mockRejectedValueOnce(
      new Error("Failed to fetch OpenAI models: 429"),
    );

    const response = await createOpenAiKey();

    const message = response.json().error.message;
    expect(message).toContain("Northwind Models");
    // The fetchers' own noun would be a second, contradicting name.
    expect(message).not.toContain("OpenAI");
    // Classification still keys off the raw message, so the 429 guidance survives.
    expect(message).toContain("temporary provider issue");
  });

  test("falls back to the shipped name when nothing is renamed", async () => {
    mockTestProviderApiKey.mockRejectedValueOnce(
      new Error("Failed to fetch OpenAI models: 429"),
    );

    const response = await createOpenAiKey();

    expect(response.json().error.message).toContain("OpenAI");
  });
});
