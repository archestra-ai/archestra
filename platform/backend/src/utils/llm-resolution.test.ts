import { vi } from "vitest";
import { isVertexAiEnabled } from "@/clients/gemini-client";
import { resolveProviderApiKey } from "@/clients/llm-client";
import config from "@/config";
import {
  LlmProviderApiKeyModel,
  LlmProviderApiKeyModelLinkModel,
} from "@/models";
import { beforeEach, describe, expect, test } from "@/test";
import {
  resolveFastModelName,
  resolveSmartDefaultLlm,
  resolveSmartDefaultLlmForChat,
} from "./llm-resolution";

vi.mock("@/clients/gemini-client", () => ({
  isVertexAiEnabled: vi.fn(() => false),
}));

vi.mock("@/clients/llm-client", () => ({
  resolveProviderApiKey: vi.fn(),
}));

const NO_KEY = {
  apiKey: undefined,
  source: "environment",
  chatApiKeyId: undefined,
  baseUrl: null,
};

const MOCK_MODEL = {
  id: "model-1",
  externalId: "anthropic/claude-3-5-sonnet",
  modelId: "claude-3-5-sonnet-20241022",
  provider: "anthropic" as const,
  description: null,
  contextLength: null,
  inputModalities: null,
  outputModalities: null,
  supportsToolCalling: null,
  promptPricePerToken: null,
  completionPricePerToken: null,
  customPricePerMillionInput: null,
  customPricePerMillionOutput: null,
  embeddingDimensions: null,
  ignored: false,
  discoveredViaLlmProxy: false,
  lastSyncedAt: new Date(),
  createdAt: new Date(),
  updatedAt: new Date(),
};

describe("resolveSmartDefaultLlm", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: no provider has a key
    vi.mocked(resolveProviderApiKey).mockResolvedValue(NO_KEY);
    // Default: no system keys exist
    vi.spyOn(LlmProviderApiKeyModel, "findSystemKey").mockResolvedValue(null);
  });

  test("returns null when no API keys configured", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();

    const result = await resolveSmartDefaultLlm({ organizationId: org.id });

    expect(result).toBeNull();
  });

  test("returns provider/model when a DB key with best model exists", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();

    vi.mocked(resolveProviderApiKey).mockImplementation(async (params) => {
      if (params.provider === "anthropic") {
        return {
          apiKey: "sk-ant-key",
          source: "org",
          chatApiKeyId: "key-123",
          baseUrl: null,
        };
      }
      return NO_KEY;
    });
    vi.spyOn(
      LlmProviderApiKeyModelLinkModel,
      "getBestModel",
    ).mockImplementation(async (apiKeyId) => {
      if (apiKeyId === "key-123") return MOCK_MODEL;
      return null;
    });

    const result = await resolveSmartDefaultLlm({ organizationId: org.id });

    expect(result).toEqual({
      provider: "anthropic",
      apiKey: "sk-ant-key",
      modelName: "claude-3-5-sonnet-20241022",
      baseUrl: null,
    });
  });

  test("returns system key fallback when no user-scoped key available", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();

    vi.spyOn(LlmProviderApiKeyModel, "findSystemKey").mockImplementation(
      async (provider) => {
        if (provider === "gemini") {
          return {
            id: "system-key-gemini",
            provider: "gemini",
            isSystem: true,
            baseUrl: "https://us-central1-aiplatform.googleapis.com/v1beta1",
          } as never;
        }
        return null;
      },
    );

    vi.spyOn(
      LlmProviderApiKeyModelLinkModel,
      "getBestModel",
    ).mockImplementation(async (apiKeyId) => {
      if (apiKeyId === "system-key-gemini") {
        return {
          ...MOCK_MODEL,
          id: "model-gemini",
          modelId: "gemini-2.5-pro",
          provider: "gemini",
        };
      }
      return null;
    });

    const result = await resolveSmartDefaultLlm({ organizationId: org.id });

    expect(result).toEqual({
      provider: "gemini",
      apiKey: undefined,
      modelName: "gemini-2.5-pro",
      baseUrl: "https://us-central1-aiplatform.googleapis.com/v1beta1",
    });
  });

  test("iterates providers in order and returns first available", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();

    // Both anthropic and openai have keys, but anthropic has no models
    vi.mocked(resolveProviderApiKey).mockImplementation(async (params) => {
      if (params.provider === "anthropic") {
        return {
          apiKey: "sk-ant-key",
          source: "org",
          chatApiKeyId: "ant-key-id",
          baseUrl: null,
        };
      }
      if (params.provider === "openai") {
        return {
          apiKey: "sk-openai-key",
          source: "org",
          chatApiKeyId: "openai-key-id",
          baseUrl: null,
        };
      }
      return NO_KEY;
    });

    vi.spyOn(
      LlmProviderApiKeyModelLinkModel,
      "getBestModel",
    ).mockImplementation(async (apiKeyId) => {
      if (apiKeyId === "ant-key-id") return null; // no models for anthropic
      if (apiKeyId === "openai-key-id") {
        return {
          ...MOCK_MODEL,
          id: "model-2",
          modelId: "gpt-4o",
          provider: "openai",
        };
      }
      return null;
    });

    const result = await resolveSmartDefaultLlm({ organizationId: org.id });

    // Should skip anthropic (no models) and return openai
    expect(result).toEqual({
      provider: "openai",
      apiKey: "sk-openai-key",
      modelName: "gpt-4o",
      baseUrl: null,
    });
  });

  test("works with userId undefined (org-wide keys only)", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();

    vi.mocked(resolveProviderApiKey).mockImplementation(async (params) => {
      if (params.provider === "anthropic") {
        return {
          apiKey: "sk-ant-key",
          source: "org",
          chatApiKeyId: "key-123",
          baseUrl: null,
        };
      }
      return NO_KEY;
    });
    vi.spyOn(LlmProviderApiKeyModelLinkModel, "getBestModel").mockResolvedValue(
      MOCK_MODEL,
    );

    const result = await resolveSmartDefaultLlm({ organizationId: org.id });

    expect(result).not.toBeNull();
    // Verify resolveProviderApiKey was called without userId
    expect(resolveProviderApiKey).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: org.id,
        userId: undefined,
      }),
    );
  });

  test("passes userId when provided", async ({ makeOrganization }) => {
    const org = await makeOrganization();

    await resolveSmartDefaultLlm({
      organizationId: org.id,
      userId: "user-123",
    });

    expect(resolveProviderApiKey).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: org.id,
        userId: "user-123",
      }),
    );
  });

  test("returns null when provider has env-var key but no chatApiKeyId", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();

    // API key from env var (no chatApiKeyId)
    vi.mocked(resolveProviderApiKey).mockResolvedValue({
      apiKey: "sk-env-key",
      source: "environment",
      chatApiKeyId: undefined,
      baseUrl: null,
    });

    const result = await resolveSmartDefaultLlm({ organizationId: org.id });

    expect(result).toBeNull();
  });

  test("returns null when system key exists but has no models synced", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();

    vi.spyOn(LlmProviderApiKeyModel, "findSystemKey").mockImplementation(
      async (provider) => {
        if (provider === "gemini") {
          return {
            id: "system-key-gemini",
            provider: "gemini",
            isSystem: true,
            baseUrl: null,
          } as never;
        }
        return null;
      },
    );

    vi.spyOn(LlmProviderApiKeyModelLinkModel, "getBestModel").mockResolvedValue(
      null,
    );

    const result = await resolveSmartDefaultLlm({ organizationId: org.id });

    expect(result).toBeNull();
  });
});

describe("resolveSmartDefaultLlmForChat", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: no provider has a key
    vi.mocked(resolveProviderApiKey).mockResolvedValue(NO_KEY);
    // Default: no system keys exist
    vi.spyOn(LlmProviderApiKeyModel, "findSystemKey").mockResolvedValue(null);
    // Default: Vertex AI disabled
    vi.mocked(isVertexAiEnabled).mockReturnValue(false);
  });

  test("returns DB result when a DB-managed key with model exists", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();

    vi.mocked(resolveProviderApiKey).mockImplementation(async (params) => {
      if (params.provider === "anthropic") {
        return {
          apiKey: "sk-ant-key",
          source: "org",
          chatApiKeyId: "key-123",
          baseUrl: null,
        };
      }
      return NO_KEY;
    });
    vi.spyOn(
      LlmProviderApiKeyModelLinkModel,
      "getBestModel",
    ).mockImplementation(async (apiKeyId) => {
      if (apiKeyId === "key-123") return MOCK_MODEL;
      return null;
    });

    const result = await resolveSmartDefaultLlmForChat({
      organizationId: org.id,
      userId: "user-1",
    });

    expect(result).toEqual({
      model: "claude-3-5-sonnet-20241022",
      provider: "anthropic",
    });
  });

  test("falls back to env var API key with default model when no DB key", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();

    // Simulate an env var API key for openai
    const originalApiKey = config.chat.openai.apiKey;
    config.chat.openai.apiKey = "sk-env-openai-key";

    try {
      const result = await resolveSmartDefaultLlmForChat({
        organizationId: org.id,
        userId: "user-1",
      });

      expect(result).toEqual({
        model: "gpt-5.4",
        provider: "openai",
      });
    } finally {
      config.chat.openai.apiKey = originalApiKey;
    }
  });

  test("falls back to Vertex AI when no DB keys or env vars", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();

    vi.mocked(isVertexAiEnabled).mockReturnValue(true);

    const result = await resolveSmartDefaultLlmForChat({
      organizationId: org.id,
      userId: "user-1",
    });

    expect(result).toEqual({
      model: "gemini-2.5-pro",
      provider: "gemini",
    });
  });

  test("falls back to config defaults when nothing else is available", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();

    const result = await resolveSmartDefaultLlmForChat({
      organizationId: org.id,
      userId: "user-1",
    });

    // Should return the configured defaults
    expect(result).toEqual({
      model: config.chat.defaultModel,
      provider: config.chat.defaultProvider,
    });
  });

  test("prefers DB key over env var fallback", async ({ makeOrganization }) => {
    const org = await makeOrganization();

    // Set up both a DB key and an env var key
    vi.mocked(resolveProviderApiKey).mockImplementation(async (params) => {
      if (params.provider === "anthropic") {
        return {
          apiKey: "sk-ant-db-key",
          source: "org",
          chatApiKeyId: "key-123",
          baseUrl: null,
        };
      }
      return NO_KEY;
    });
    vi.spyOn(
      LlmProviderApiKeyModelLinkModel,
      "getBestModel",
    ).mockImplementation(async (apiKeyId) => {
      if (apiKeyId === "key-123") return MOCK_MODEL;
      return null;
    });

    const originalApiKey = config.chat.openai.apiKey;
    config.chat.openai.apiKey = "sk-env-openai-key";

    try {
      const result = await resolveSmartDefaultLlmForChat({
        organizationId: org.id,
        userId: "user-1",
      });

      // Should use DB key (anthropic), not env var (openai)
      expect(result).toEqual({
        model: "claude-3-5-sonnet-20241022",
        provider: "anthropic",
      });
    } finally {
      config.chat.openai.apiKey = originalApiKey;
    }
  });
});

describe("resolveFastModelName", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("returns hardcoded FAST_MODELS fallback when no chatApiKeyId", async () => {
    const result = await resolveFastModelName("anthropic", undefined);

    // Should return the hardcoded fast model for anthropic
    expect(result).toBe("claude-haiku-4-5-20251001");
  });

  test("returns fastest model from DB when chatApiKeyId is provided", async () => {
    vi.spyOn(
      LlmProviderApiKeyModelLinkModel,
      "getFastestModel",
    ).mockResolvedValue({
      ...MOCK_MODEL,
      modelId: "claude-haiku-3-5",
    });

    const result = await resolveFastModelName("anthropic", "key-123");

    expect(result).toBe("claude-haiku-3-5");
    expect(
      LlmProviderApiKeyModelLinkModel.getFastestModel,
    ).toHaveBeenCalledWith("key-123");
  });

  test("falls back to hardcoded model when DB has no fastest model", async () => {
    vi.spyOn(
      LlmProviderApiKeyModelLinkModel,
      "getFastestModel",
    ).mockResolvedValue(null);

    const result = await resolveFastModelName("openai", "key-456");

    expect(result).toBe("gpt-4o-mini");
  });

  test("falls back to hardcoded model when DB lookup throws", async () => {
    vi.spyOn(
      LlmProviderApiKeyModelLinkModel,
      "getFastestModel",
    ).mockRejectedValue(new Error("DB connection failed"));

    const result = await resolveFastModelName("openai", "key-789");

    expect(result).toBe("gpt-4o-mini");
  });
});
