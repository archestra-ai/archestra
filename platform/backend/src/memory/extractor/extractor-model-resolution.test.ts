import { vi } from "vitest";
import { beforeEach, describe, expect, test } from "@/test";

const {
  mockDetectProviderFromModel,
  mockGetOrganizationById,
  mockGetProviderEnvApiKey,
  mockResolveApiKeyFromChatApiKey,
} = vi.hoisted(() => ({
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
  };
});

describe("memory extractor model resolution order", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("prefers org override over org default", async () => {
    mockGetOrganizationById.mockResolvedValue({
      memoryExtractorModel: "gpt-4o-mini",
      memoryExtractorChatApiKeyId: "override-key-id",
      defaultLlmModel: "claude-3-5-haiku-20241022",
      defaultLlmProvider: "anthropic",
      defaultLlmApiKeyId: "org-default-key-id",
    });

    mockResolveApiKeyFromChatApiKey.mockResolvedValue({
      provider: "openai",
      apiKey: "override-api-key",
      baseUrl: "https://override.example.com",
    });

    const { memoryExtractor } = await import("./extractor");
    const resolveModelConfig = getResolveModelConfig(memoryExtractor);
    const resolved = await resolveModelConfig({ organizationId: "org-1" });

    expect(resolved).toEqual({
      source: "organization_override",
      modelName: "gpt-4o-mini",
      provider: "openai",
      apiKey: "override-api-key",
      baseUrl: "https://override.example.com",
    });
  });

  test("uses org default when override is not configured", async () => {
    mockGetOrganizationById.mockResolvedValue({
      memoryExtractorModel: null,
      memoryExtractorChatApiKeyId: null,
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

  test("returns null when neither override nor org default resolves", async () => {
    mockGetOrganizationById.mockResolvedValue({
      memoryExtractorModel: null,
      memoryExtractorChatApiKeyId: null,
      defaultLlmModel: null,
      defaultLlmProvider: null,
      defaultLlmApiKeyId: null,
    });

    const { memoryExtractor } = await import("./extractor");
    const resolveModelConfig = getResolveModelConfig(memoryExtractor);
    const resolved = await resolveModelConfig({ organizationId: "org-1" });

    expect(resolved).toBeNull();
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
