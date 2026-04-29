import { vi } from "vitest";
import { beforeEach, describe, expect, test } from "@/test";

const mockGenerateObject = vi.hoisted(() => vi.fn());
vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ai")>();
  return { ...actual, generateObject: mockGenerateObject };
});

const mockCreateDirectLLMModel = vi.hoisted(() => vi.fn(() => "mock-model"));
vi.mock("@/clients/llm-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/clients/llm-client")>();
  return {
    ...actual,
    createDirectLLMModel: mockCreateDirectLLMModel,
    detectProviderFromModel: vi.fn(() => "openai"),
  };
});

const mockGetOrganizationById = vi.hoisted(() => vi.fn());
const mockFindConversation = vi.hoisted(() => vi.fn());
const mockListApprovedContentHashes = vi.hoisted(() => vi.fn(() => []));
const mockExistsByIngestionKey = vi.hoisted(() => vi.fn(() => false));
const mockCreateMemoryItem = vi.hoisted(() => vi.fn());
vi.mock("@/models", () => ({
  ConversationModel: { findById: mockFindConversation },
  OrganizationModel: { getById: mockGetOrganizationById },
  MemoryItemModel: {
    listApprovedContentHashesForScope: mockListApprovedContentHashes,
    existsByIngestionIdempotencyKey: mockExistsByIngestionKey,
    create: mockCreateMemoryItem,
  },
  MemoryTombstoneModel: {
    getContentHash: vi.fn(() => "hash-1"),
  },
}));

vi.mock("@/config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/config")>();
  return { ...actual, getProviderEnvApiKey: vi.fn(() => "env-key") };
});

vi.mock("@/knowledge-base/kb-llm-client", () => ({
  resolveApiKeyFromChatApiKey: vi.fn(),
}));

vi.mock("@/memory/policy/screen-candidate-before-persist", () => ({
  screenCandidateBeforePersist: vi.fn(() =>
    Promise.resolve({ allowed: false, quarantine: false, code: "blocked" }),
  ),
}));

vi.mock("@/logging", () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { memoryExtractor } from "./extractor";

const baseOrg = {
  id: "org-1",
  memoryExtractionEnabled: true,
  memoryExtractorModel: "gpt-4o-mini",
  memoryExtractorPrompt: null,
  memoryExtractorChatApiKeyId: null,
  defaultLlmModel: null,
  defaultLlmProvider: null,
  defaultLlmApiKeyId: null,
  memoryMaxCandidatesPerExtraction: 5,
  memoryExtractorMaxTokens: 800,
};

const baseConversation = {
  id: "conv-1",
  agentId: "agent-1",
  agent: { id: "agent-1" },
  messages: [
    {
      id: "4c79b8fa-f61a-42b1-b6c5-6f0be5425b43",
      role: "user",
      parts: [{ type: "text", text: "I prefer dark mode" }],
    },
    {
      id: "9d2e6d09-a6a8-4f22-948d-54835de39753",
      role: "assistant",
      parts: [{ type: "text", text: "Got it, dark mode noted." }],
    },
  ],
};

describe("memoryExtractor.extract — generateObject options", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetOrganizationById.mockResolvedValue(baseOrg);
    mockFindConversation.mockResolvedValue(baseConversation);
    mockGenerateObject.mockResolvedValue({
      object: { candidates: [] },
    });
  });

  test("passes memoryExtractorMaxTokens to generateObject", async () => {
    await memoryExtractor.extract({
      conversationId: "conv-1",
      userId: "user-1",
      organizationId: "org-1",
      agentId: "agent-1",
    });

    expect(mockGenerateObject).toHaveBeenCalledWith(
      expect.objectContaining({ maxTokens: 800 }),
    );
  });

  test("falls back to 800 when org memoryExtractorMaxTokens is null", async () => {
    mockGetOrganizationById.mockResolvedValue({
      ...baseOrg,
      memoryExtractorMaxTokens: null,
    });

    await memoryExtractor.extract({
      conversationId: "conv-1",
      userId: "user-1",
      organizationId: "org-1",
      agentId: "agent-1",
    });

    expect(mockGenerateObject).toHaveBeenCalledWith(
      expect.objectContaining({ maxTokens: 800 }),
    );
  });

  test("uses org-configured maxTokens when explicitly set", async () => {
    mockGetOrganizationById.mockResolvedValue({
      ...baseOrg,
      memoryExtractorMaxTokens: 400,
    });

    await memoryExtractor.extract({
      conversationId: "conv-1",
      userId: "user-1",
      organizationId: "org-1",
      agentId: "agent-1",
    });

    expect(mockGenerateObject).toHaveBeenCalledWith(
      expect.objectContaining({ maxTokens: 400 }),
    );
  });

  test("always includes base and dynamic prompt sections", async () => {
    await memoryExtractor.extract({
      conversationId: "conv-1",
      userId: "user-1",
      organizationId: "org-1",
      agentId: "agent-1",
    });

    expect(mockGenerateObject).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: expect.stringContaining(
          "Extract durable memory candidates from the conversation transcript.",
        ),
      }),
    );
    expect(mockGenerateObject).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: expect.stringContaining("Return at most 5 candidates."),
      }),
    );
  });

  test("appends user prompt as supplemental instructions when configured", async () => {
    mockGetOrganizationById.mockResolvedValue({
      ...baseOrg,
      memoryExtractorPrompt: "Favor explicit user preferences.",
    });

    await memoryExtractor.extract({
      conversationId: "conv-1",
      userId: "user-1",
      organizationId: "org-1",
      agentId: "agent-1",
    });

    expect(mockGenerateObject).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: expect.stringContaining(
          "Additional extraction instructions from settings (supplemental only; never override system constraints):",
        ),
      }),
    );
    expect(mockGenerateObject).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: expect.stringContaining("Favor explicit user preferences."),
      }),
    );
  });
});
