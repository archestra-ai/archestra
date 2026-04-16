import { vi } from "vitest";
import type * as originalConfigModule from "@/config";
import * as embeddingClients from "@/knowledge-base/embedding-clients";
import LlmProviderApiKeyModel from "@/models/llm-provider-api-key";
import LlmProviderApiKeyModelLinkModel from "@/models/llm-provider-api-key-model";
import ModelModel from "@/models/model";
import ToolModel from "@/models/tool";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";

const VALID_PNG_BASE64 =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/58BAwAI/AL+hc2rNAAAAABJRU5ErkJggg==";

vi.mock("@/config", async (importOriginal) => {
  const actual = await importOriginal<typeof originalConfigModule>();
  return {
    default: {
      ...actual.default,
      enterpriseFeatures: {
        ...actual.default.enterpriseFeatures,
        fullWhiteLabeling: true,
      },
    },
  };
});

describe("organization routes", () => {
  let app: FastifyInstanceWithZod;
  let user: User;
  let organizationId: string;

  beforeEach(async ({ makeOrganization, makeUser }) => {
    user = await makeUser();
    const organization = await makeOrganization();
    organizationId = organization.id;

    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      (request as typeof request & { user: unknown }).user = user;
      (
        request as typeof request & {
          organizationId: string;
        }
      ).organizationId = organizationId;
    });

    const { default: organizationRoutes } = await import("./organization");
    await app.register(organizationRoutes);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await app.close();
  });

  test("syncs built-in MCP branding when appName changes under full white labeling", async () => {
    const syncSpy = vi
      .spyOn(ToolModel, "syncArchestraBuiltInCatalog")
      .mockResolvedValue();

    const response = await app.inject({
      method: "PATCH",
      url: "/api/organization/appearance-settings",
      payload: {
        appName: "Acme Copilot",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(syncSpy).toHaveBeenCalledWith({
      organization: expect.objectContaining({
        appName: "Acme Copilot",
      }),
    });
  });

  test("does not resync built-in MCP branding when appName is unchanged", async () => {
    const syncSpy = vi
      .spyOn(ToolModel, "syncArchestraBuiltInCatalog")
      .mockResolvedValue();

    const response = await app.inject({
      method: "PATCH",
      url: "/api/organization/appearance-settings",
      payload: {},
    });

    expect(response.statusCode).toBe(200);
    expect(syncSpy).not.toHaveBeenCalled();
  });

  test("does not resync built-in MCP branding when only logo assets change", async () => {
    const syncSpy = vi
      .spyOn(ToolModel, "syncArchestraBuiltInCatalog")
      .mockResolvedValue();

    const response = await app.inject({
      method: "PATCH",
      url: "/api/organization/appearance-settings",
      payload: {
        logo: VALID_PNG_BASE64,
        logoDark: VALID_PNG_BASE64,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(syncSpy).not.toHaveBeenCalled();
  });

  test("resyncs built-in MCP branding when iconLogo changes", async () => {
    const syncSpy = vi
      .spyOn(ToolModel, "syncArchestraBuiltInCatalog")
      .mockResolvedValue();

    const response = await app.inject({
      method: "PATCH",
      url: "/api/organization/appearance-settings",
      payload: {
        iconLogo: VALID_PNG_BASE64,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(syncSpy).toHaveBeenCalledWith({
      organization: expect.objectContaining({
        iconLogo: VALID_PNG_BASE64,
      }),
    });
  });

  describe("PATCH /api/organization/appearance-settings - logo validation", () => {
    test("rejects invalid Base64 payload", async () => {
      const response = await app.inject({
        method: "PATCH",
        url: "/api/organization/appearance-settings",
        payload: { logo: "data:image/png;base64,NotAnImageJustText" },
      });

      expect(response.statusCode).toBe(400);
      const body = response.json();
      expect(body.error.message).toContain("Base64");
    });

    test("rejects valid Base64 with non-PNG content", async () => {
      const response = await app.inject({
        method: "PATCH",
        url: "/api/organization/appearance-settings",
        payload: { logo: "data:image/png;base64,SGVsbG8gV29ybGQ=" },
      });

      expect(response.statusCode).toBe(400);
      const body = response.json();
      expect(body.error.message).toContain("PNG");
    });

    test("rejects wrong MIME type prefix", async () => {
      const response = await app.inject({
        method: "PATCH",
        url: "/api/organization/appearance-settings",
        payload: { logo: "data:image/jpeg;base64,/9j/4AAQSkZJRg==" },
      });

      expect(response.statusCode).toBe(400);
      const body = response.json();
      expect(body.error.message).toContain("PNG");
    });

    test("accepts valid PNG logo and returns correct response", async () => {
      const response = await app.inject({
        method: "PATCH",
        url: "/api/organization/appearance-settings",
        payload: { logo: VALID_PNG_BASE64 },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.logo).toBe(VALID_PNG_BASE64);
      expect(body).toHaveProperty("id");
      expect(body).toHaveProperty("name");
    });

    test("accepts null logo for removal and maintains other fields", async () => {
      // First set a logo
      await app.inject({
        method: "PATCH",
        url: "/api/organization/appearance-settings",
        payload: { logo: VALID_PNG_BASE64 },
      });

      // Then remove it
      const response = await app.inject({
        method: "PATCH",
        url: "/api/organization/appearance-settings",
        payload: { logo: null },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.logo).toBeNull();
      expect(body).toHaveProperty("id");
      expect(body).toHaveProperty("name");
    });
  });

  describe("PATCH /api/organization/appearance-settings - fields", () => {
    test("updates and retrieves appName", async () => {
      const response = await app.inject({
        method: "PATCH",
        url: "/api/organization/appearance-settings",
        payload: { appName: "My Custom App" },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().appName).toBe("My Custom App");
    });

    test("rejects appName exceeding 100 characters", async () => {
      const response = await app.inject({
        method: "PATCH",
        url: "/api/organization/appearance-settings",
        payload: { appName: "a".repeat(101) },
      });

      expect(response.statusCode).toBe(400);
    });

    test("updates and retrieves ogDescription", async () => {
      const response = await app.inject({
        method: "PATCH",
        url: "/api/organization/appearance-settings",
        payload: { ogDescription: "Custom OG description" },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().ogDescription).toBe("Custom OG description");
    });

    test("updates and retrieves footerText", async () => {
      const response = await app.inject({
        method: "PATCH",
        url: "/api/organization/appearance-settings",
        payload: { footerText: "© 2026 Custom Footer" },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().footerText).toBe("© 2026 Custom Footer");
    });

    test("rejects footerText exceeding 500 characters", async () => {
      const response = await app.inject({
        method: "PATCH",
        url: "/api/organization/appearance-settings",
        payload: { footerText: "a".repeat(501) },
      });

      expect(response.statusCode).toBe(400);
    });

    test("updates and retrieves chatPlaceholders", async () => {
      const placeholders = ["Ask me anything", "How can I help?"];
      const response = await app.inject({
        method: "PATCH",
        url: "/api/organization/appearance-settings",
        payload: { chatPlaceholders: placeholders },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().chatPlaceholders).toEqual(placeholders);
    });

    test("rejects chatPlaceholders exceeding 20 entries", async () => {
      const response = await app.inject({
        method: "PATCH",
        url: "/api/organization/appearance-settings",
        payload: {
          chatPlaceholders: Array.from({ length: 21 }, (_, i) => `Item ${i}`),
        },
      });

      expect(response.statusCode).toBe(400);
    });

    test("rejects chatPlaceholders with entry exceeding 80 chars", async () => {
      const response = await app.inject({
        method: "PATCH",
        url: "/api/organization/appearance-settings",
        payload: { chatPlaceholders: ["a".repeat(81)] },
      });

      expect(response.statusCode).toBe(400);
    });

    test("updates showTwoFactor toggle", async () => {
      const response = await app.inject({
        method: "PATCH",
        url: "/api/organization/appearance-settings",
        payload: { showTwoFactor: true },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().showTwoFactor).toBe(true);
    });

    test("updates slimChatErrorUi toggle", async () => {
      const response = await app.inject({
        method: "PATCH",
        url: "/api/organization/appearance-settings",
        payload: { slimChatErrorUi: true },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().slimChatErrorUi).toBe(true);
    });

    test("accepts favicon as valid PNG", async () => {
      const response = await app.inject({
        method: "PATCH",
        url: "/api/organization/appearance-settings",
        payload: { favicon: VALID_PNG_BASE64 },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().favicon).toBe(VALID_PNG_BASE64);
    });

    test("updates multiple fields at once", async () => {
      const response = await app.inject({
        method: "PATCH",
        url: "/api/organization/appearance-settings",
        payload: {
          appName: "Multi-update Test",
          footerText: "Test Footer",
          showTwoFactor: true,
          chatPlaceholders: ["Hello", "World"],
        },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.appName).toBe("Multi-update Test");
      expect(body.footerText).toBe("Test Footer");
      expect(body.showTwoFactor).toBe(true);
      expect(body.chatPlaceholders).toEqual(["Hello", "World"]);
    });

    test("persists changes across reads", async () => {
      await app.inject({
        method: "PATCH",
        url: "/api/organization/appearance-settings",
        payload: {
          appName: "Persistence Test",
          footerText: "Persistent Footer",
        },
      });

      // GET /appearance-settings returns AppearanceSettingsSchema (subset of fields)
      const response = await app.inject({
        method: "GET",
        url: "/api/organization/appearance-settings",
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.appName).toBe("Persistence Test");
      expect(body.footerText).toBe("Persistent Footer");
    });
  });

  describe("PATCH /api/organization/security-settings", () => {
    test("updates global tool policy and chat file upload settings", async () => {
      const response = await app.inject({
        method: "PATCH",
        url: "/api/organization/security-settings",
        payload: {
          globalToolPolicy: "restrictive",
          allowChatFileUploads: false,
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        globalToolPolicy: "restrictive",
        allowChatFileUploads: false,
      });
    });

    test("persists security settings across reads", async () => {
      await app.inject({
        method: "PATCH",
        url: "/api/organization/security-settings",
        payload: {
          globalToolPolicy: "permissive",
          allowChatFileUploads: true,
        },
      });

      const response = await app.inject({
        method: "GET",
        url: "/api/organization",
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        globalToolPolicy: "permissive",
        allowChatFileUploads: true,
      });
    });
  });

  describe("PATCH /api/organization/llm-settings", () => {
    test("updates compression scope and TOON conversion", async () => {
      const response = await app.inject({
        method: "PATCH",
        url: "/api/organization/llm-settings",
        payload: {
          compressionScope: "team",
          convertToolResultsToToon: true,
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        compressionScope: "team",
        convertToolResultsToToon: true,
      });
    });

    test("persists limit cleanup interval across reads", async () => {
      await app.inject({
        method: "PATCH",
        url: "/api/organization/llm-settings",
        payload: {
          compressionScope: "organization",
          convertToolResultsToToon: false,
          limitCleanupInterval: "12h",
        },
      });

      const response = await app.inject({
        method: "GET",
        url: "/api/organization",
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        compressionScope: "organization",
        convertToolResultsToToon: false,
        limitCleanupInterval: "12h",
      });
    });
  });

  describe("PATCH /api/organization/knowledge-settings", () => {
    test("allows clearing embedding model with null", async ({
      makeSecret,
    }) => {
      const secret = await makeSecret({ secret: { apiKey: "test-key" } });
      const apiKey = await LlmProviderApiKeyModel.create({
        organizationId,
        secretId: secret.id,
        name: "Embedding Key",
        provider: "gemini",
        scope: "personal",
        userId: user.id,
      });
      const model = await ModelModel.create({
        externalId: "gemini/gemini-embedding-001",
        provider: "gemini",
        modelId: "gemini-embedding-001",
        description: "Gemini Embedding 001",
        contextLength: null,
        inputModalities: ["text"],
        outputModalities: [],
        supportsToolCalling: false,
        promptPricePerToken: null,
        completionPricePerToken: null,
        embeddingDimensions: 3072,
        lastSyncedAt: new Date(),
      });

      await LlmProviderApiKeyModelLinkModel.syncModelsForApiKey(
        apiKey.id,
        [{ id: model.id, modelId: model.modelId }],
        "gemini",
      );

      const setResponse = await app.inject({
        method: "PATCH",
        url: "/api/organization/knowledge-settings",
        payload: {
          embeddingChatApiKeyId: apiKey.id,
          embeddingModel: model.modelId,
        },
      });

      expect(setResponse.statusCode).toBe(200);

      const clearResponse = await app.inject({
        method: "PATCH",
        url: "/api/organization/knowledge-settings",
        payload: {
          embeddingModel: null,
        },
      });

      expect(clearResponse.statusCode).toBe(200);
      expect(clearResponse.json().embeddingModel).toBeNull();
    });

    test("rejects embedding models that are missing configured dimensions", async ({
      makeSecret,
    }) => {
      const secret = await makeSecret({ secret: { apiKey: "test-key" } });
      const apiKey = await LlmProviderApiKeyModel.create({
        organizationId,
        secretId: secret.id,
        name: "Embedding Key",
        provider: "gemini",
        scope: "personal",
        userId: user.id,
      });
      const model = await ModelModel.create({
        externalId: "gemini/custom-embed-v2",
        provider: "gemini",
        modelId: "custom-embed-v2",
        description: "Custom Embed V2",
        contextLength: null,
        inputModalities: ["text"],
        outputModalities: [],
        supportsToolCalling: false,
        promptPricePerToken: null,
        completionPricePerToken: null,
        embeddingDimensions: null,
        lastSyncedAt: new Date(),
      });

      await LlmProviderApiKeyModelLinkModel.syncModelsForApiKey(
        apiKey.id,
        [{ id: model.id, modelId: model.modelId }],
        "gemini",
      );

      const response = await app.inject({
        method: "PATCH",
        url: "/api/organization/knowledge-settings",
        payload: {
          embeddingChatApiKeyId: apiKey.id,
          embeddingModel: model.modelId,
        },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().error.message).toContain("configured dimensions");
    });

    test("accepts embedding models that are marked with dimensions", async ({
      makeSecret,
    }) => {
      const secret = await makeSecret({ secret: { apiKey: "test-key" } });
      const apiKey = await LlmProviderApiKeyModel.create({
        organizationId,
        secretId: secret.id,
        name: "Embedding Key",
        provider: "gemini",
        scope: "personal",
        userId: user.id,
      });
      const model = await ModelModel.create({
        externalId: "gemini/gemini-embedding-001",
        provider: "gemini",
        modelId: "gemini-embedding-001",
        description: "Gemini Embedding 001",
        contextLength: null,
        inputModalities: ["text"],
        outputModalities: [],
        supportsToolCalling: false,
        promptPricePerToken: null,
        completionPricePerToken: null,
        embeddingDimensions: 3072,
        lastSyncedAt: new Date(),
      });

      await LlmProviderApiKeyModelLinkModel.syncModelsForApiKey(
        apiKey.id,
        [{ id: model.id, modelId: model.modelId }],
        "gemini",
      );

      const response = await app.inject({
        method: "PATCH",
        url: "/api/organization/knowledge-settings",
        payload: {
          embeddingChatApiKeyId: apiKey.id,
          embeddingModel: model.modelId,
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().embeddingModel).toBe(model.modelId);
    });

    test("rejects changing embedding API key once embedding config is locked", async ({
      makeSecret,
    }) => {
      const secret1 = await makeSecret({ secret: { apiKey: "test-key-1" } });
      const secret2 = await makeSecret({ secret: { apiKey: "test-key-2" } });
      const apiKey1 = await LlmProviderApiKeyModel.create({
        organizationId,
        secretId: secret1.id,
        name: "Embedding Key 1",
        provider: "gemini",
        scope: "personal",
        userId: user.id,
      });
      const apiKey2 = await LlmProviderApiKeyModel.create({
        organizationId,
        secretId: secret2.id,
        name: "Embedding Key 2",
        provider: "gemini",
        scope: "personal",
        userId: user.id,
      });
      const model = await ModelModel.create({
        externalId: "gemini/gemini-embedding-001",
        provider: "gemini",
        modelId: "gemini-embedding-001",
        description: "Gemini Embedding 001",
        contextLength: null,
        inputModalities: ["text"],
        outputModalities: [],
        supportsToolCalling: false,
        promptPricePerToken: null,
        completionPricePerToken: null,
        embeddingDimensions: 3072,
        lastSyncedAt: new Date(),
      });

      await Promise.all([
        LlmProviderApiKeyModelLinkModel.syncModelsForApiKey(
          apiKey1.id,
          [{ id: model.id, modelId: model.modelId }],
          "gemini",
        ),
        LlmProviderApiKeyModelLinkModel.syncModelsForApiKey(
          apiKey2.id,
          [{ id: model.id, modelId: model.modelId }],
          "gemini",
        ),
      ]);

      const setResponse = await app.inject({
        method: "PATCH",
        url: "/api/organization/knowledge-settings",
        payload: {
          embeddingChatApiKeyId: apiKey1.id,
          embeddingModel: model.modelId,
        },
      });

      expect(setResponse.statusCode).toBe(200);

      const changeKeyResponse = await app.inject({
        method: "PATCH",
        url: "/api/organization/knowledge-settings",
        payload: {
          embeddingChatApiKeyId: apiKey2.id,
        },
      });

      expect(changeKeyResponse.statusCode).toBe(400);
      expect(changeKeyResponse.json().error.message).toContain(
        "Embedding API key cannot be changed once configured",
      );
    });
  });

  describe("PATCH /api/organization/mcp-settings", () => {
    test("updates the MCP OAuth access token lifetime", async () => {
      const response = await app.inject({
        method: "PATCH",
        url: "/api/organization/mcp-settings",
        payload: {
          mcpOauthAccessTokenLifetimeSeconds: 604_800,
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().mcpOauthAccessTokenLifetimeSeconds).toBe(604_800);
    });

    test("rejects values below the minimum lifetime", async () => {
      const response = await app.inject({
        method: "PATCH",
        url: "/api/organization/mcp-settings",
        payload: {
          mcpOauthAccessTokenLifetimeSeconds: 299,
        },
      });

      expect(response.statusCode).toBe(400);
    });

    test("rejects values above the maximum lifetime", async () => {
      const response = await app.inject({
        method: "PATCH",
        url: "/api/organization/mcp-settings",
        payload: {
          mcpOauthAccessTokenLifetimeSeconds: 31_536_001,
        },
      });

      expect(response.statusCode).toBe(400);
    });
  });

  describe("POST /api/organization/knowledge-settings/test-embedding", () => {
    test("passes configured embedding dimensions to callEmbedding", async ({
      makeSecret,
    }) => {
      const secret = await makeSecret({ secret: { apiKey: "test-key" } });
      const apiKey = await LlmProviderApiKeyModel.create({
        organizationId,
        secretId: secret.id,
        name: "Embedding Key",
        provider: "gemini",
        scope: "personal",
        userId: user.id,
      });
      await ModelModel.create({
        externalId: "gemini/gemini-embedding-001",
        provider: "gemini",
        modelId: "gemini-embedding-001",
        description: "Gemini Embedding 001",
        contextLength: null,
        inputModalities: ["text"],
        outputModalities: [],
        supportsToolCalling: false,
        promptPricePerToken: null,
        completionPricePerToken: null,
        embeddingDimensions: 3072,
        lastSyncedAt: new Date(),
      });

      const callEmbeddingSpy = vi
        .spyOn(embeddingClients, "callEmbedding")
        .mockResolvedValue({
          object: "list",
          data: [{ object: "embedding", embedding: [0.1, 0.2], index: 0 }],
          model: "gemini-embedding-001",
          usage: { prompt_tokens: 0, total_tokens: 0 },
        });

      const response = await app.inject({
        method: "POST",
        url: "/api/organization/knowledge-settings/test-embedding",
        payload: {
          embeddingChatApiKeyId: apiKey.id,
          embeddingModel: "gemini-embedding-001",
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ success: true });
      expect(callEmbeddingSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: "gemini",
          model: "gemini-embedding-001",
          dimensions: 3072,
        }),
      );
    });
  });
});
