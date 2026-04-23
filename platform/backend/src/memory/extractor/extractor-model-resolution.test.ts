import { vi } from "vitest";
import { beforeEach, describe, expect, test } from "@/test";

const {
  memoryConfigOverride,
  mockDetectProviderFromModel,
  mockGetOrganizationById,
  mockGetProviderEnvApiKey,
  mockResolveApiKeyFromChatApiKey,
} = vi.hoisted(() => ({
  memoryConfigOverride: {
    extractorModelOverride: "gpt-4o-mini" as string | undefined,
    extractorApiKeyIdOverride: "override-key-id" as string | undefined,
    extractorFallbackModel: "claude-haiku-4-5",
    extractorFallbackApiKeyId: undefined as string | undefined,
    maxCandidatesPerExtraction: 5,
  },
  mockDetectProviderFromModel: vi.fn(() => "openai"),
  mockGetOrganizationById: vi.fn(),
  mockGetProviderEnvApiKey: vi.fn((provider: string) => `env-${provider}`),
  mockResolveApiKeyFromChatApiKey: vi.fn(),
}));

vi.mock("@/clients/llm-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/clients/llm-client")>();
  return {
    ...actual,
    detectProviderFromModel: mockDetectProviderFromModel,
  };
});

vi.mock("@/models/organization", () => ({
  default: {
    getById: mockGetOrganizationById,
  },
}));

vi.mock("@/knowledge-base/kb-llm-client", () => ({
  resolveApiKeyFromChatApiKey: mockResolveApiKeyFromChatApiKey,
}));

vi.mock("@/config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/config")>();
  return {
    ...actual,
    getProviderEnvApiKey: mockGetProviderEnvApiKey,
    default: new Proxy(actual.default, {
      get(target, prop, receiver) {
        if (prop === "memory") {
          return {
            ...target.memory,
            ...memoryConfigOverride,
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    }),
  };
});

describe("memory extractor model resolution order", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("prefers explicit override over organization defaults and fallback", async () => {
    memoryConfigOverride.extractorModelOverride = "gpt-4o-mini";
    memoryConfigOverride.extractorApiKeyIdOverride = "override-key-id";
    memoryConfigOverride.extractorFallbackModel = "claude-haiku-4-5";
    memoryConfigOverride.extractorFallbackApiKeyId = undefined;

    mockResolveApiKeyFromChatApiKey.mockResolvedValue({
      provider: "openai",
      apiKey: "override-api-key",
      baseUrl: "https://override.example.com",
    });

    const { memoryExtractor } = await import("./extractor");
    const resolveModelConfig = getResolveModelConfig(memoryExtractor);
    const resolved = await resolveModelConfig({ organizationId: "org-1" });

    expect(resolved).toEqual({
      source: "override",
      modelName: "gpt-4o-mini",
      provider: "openai",
      apiKey: "override-api-key",
      baseUrl: "https://override.example.com",
    });
    expect(mockGetOrganizationById).not.toHaveBeenCalled();
  });

  test("uses organization default when override is not configured", async () => {
    memoryConfigOverride.extractorModelOverride = undefined;
    memoryConfigOverride.extractorApiKeyIdOverride = undefined;
    memoryConfigOverride.extractorFallbackModel = "claude-haiku-4-5";
    memoryConfigOverride.extractorFallbackApiKeyId = undefined;

    mockGetOrganizationById.mockResolvedValue({
      defaultLlmModel: "claude-3-5-haiku-20241022",
      defaultLlmProvider: "anthropic",
      defaultLlmApiKeyId: "org-default-key-id",
    });
    mockResolveApiKeyFromChatApiKey.mockResolvedValue({
      provider: "anthropic",
      apiKey: "org-default-api-key",
      baseUrl: null,
    });

    const { memoryExtractor } = await import("./extractor");
    const resolveModelConfig = getResolveModelConfig(memoryExtractor);
    const resolved = await resolveModelConfig({ organizationId: "org-1" });

    expect(resolved).toEqual({
      source: "organization_default",
      modelName: "claude-3-5-haiku-20241022",
      provider: "anthropic",
      apiKey: "org-default-api-key",
      baseUrl: null,
    });
  });

  test("falls back when neither override nor organization default resolves", async () => {
    memoryConfigOverride.extractorModelOverride = undefined;
    memoryConfigOverride.extractorApiKeyIdOverride = undefined;
    memoryConfigOverride.extractorFallbackModel = "gpt-4o-mini";
    memoryConfigOverride.extractorFallbackApiKeyId = undefined;

    mockGetOrganizationById.mockResolvedValue({
      defaultLlmModel: null,
      defaultLlmProvider: null,
      defaultLlmApiKeyId: null,
    });
    mockDetectProviderFromModel.mockReturnValue("openai");

    const { memoryExtractor } = await import("./extractor");
    const resolveModelConfig = getResolveModelConfig(memoryExtractor);
    const resolved = await resolveModelConfig({ organizationId: "org-1" });

    expect(resolved).toEqual({
      source: "fallback",
      modelName: "gpt-4o-mini",
      provider: "openai",
      apiKey: "env-openai",
      baseUrl: null,
    });
    expect(mockGetProviderEnvApiKey).toHaveBeenCalledWith("openai");
  });
});

function getResolveModelConfig(
  memoryExtractor: unknown,
): (params: { organizationId: string }) => Promise<unknown> {
  return (
    memoryExtractor as {
      resolveModelConfig: (params: {
        organizationId: string;
      }) => Promise<unknown>;
    }
  ).resolveModelConfig.bind(memoryExtractor);
}
